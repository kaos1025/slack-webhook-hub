#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const DEFAULT_ENV_FILE = ".env.local";
const DEFAULT_COMMAND_JOBS_TABLE = "command_jobs";
const DEFAULT_ROUTE_PREFIX = "petcut";
const DEFAULT_SOURCE_USER_ID = "hermes-direct";
const ROUTINE_COMMAND_PREFIX = "클로드,";

function usage() {
  return `Usage:
  node scripts/enqueue-from-hermes.mjs --route petcut --text "클로드, petcut ..."
  node scripts/enqueue-from-hermes.mjs --route petcut --file /tmp/prompt.txt

Options:
  --route <prefix|project>       Route commandPrefix or project to use. Default: petcut
  --text <message>               Slack parent message / command text
  --file <path>                  Read message text from file
  --env-file <path>              Env file to load. Default: .env.local
  --dry-run                      Build payload only; do not call Slack or Supabase
  --no-slack                     Enqueue only; do not post parent Slack message. Requires --thread-ts or --message-ts
  --thread-ts <ts>               Existing Slack thread timestamp for worker replies
  --message-ts <ts>              Existing Slack message timestamp
  --channel <id>                 Override route channel id
  --source-user-id <id>          command_jobs.user_id value. Default: hermes-direct
  --idempotency-key <key>        Explicit idempotency key
  --help                         Show this help
`;
}

function parseArgs(argv) {
  const args = {
    route: DEFAULT_ROUTE_PREFIX,
    envFile: DEFAULT_ENV_FILE,
    dryRun: false,
    postSlack: true,
    sourceUserId: DEFAULT_SOURCE_USER_ID
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--route") args.route = readValue();
    else if (arg === "--text") args.text = readValue();
    else if (arg === "--file") args.file = readValue();
    else if (arg === "--env-file") args.envFile = readValue();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-slack") args.postSlack = false;
    else if (arg === "--thread-ts") args.threadTs = readValue();
    else if (arg === "--message-ts") args.messageTs = readValue();
    else if (arg === "--channel") args.channel = readValue();
    else if (arg === "--source-user-id") args.sourceUserId = readValue();
    else if (arg === "--idempotency-key") args.idempotencyKey = readValue();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadDotEnvFile(filePath = DEFAULT_ENV_FILE) {
  const resolved = path.resolve(process.cwd(), filePath);
  let content;
  try {
    content = await readFile(resolved, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const equalsIndex = line.indexOf("=");
    const key = line.slice(0, equalsIndex).trim();
    if (!key || key.startsWith("export ")) continue;
    parsed[key] = unquoteEnvValue(line.slice(equalsIndex + 1));
  }
  return parsed;
}

function getConfiguredRoutes(env) {
  if (!env.SLACK_ROUTES_JSON) return [];
  const parsed = JSON.parse(env.SLACK_ROUTES_JSON);
  if (!Array.isArray(parsed)) throw new Error("SLACK_ROUTES_JSON must be a JSON array");
  return parsed.filter((route) => route && typeof route === "object");
}

function normalizeRouteKey(value) {
  return String(value || "").trim().toLowerCase();
}

function findRoute(env, routeKey) {
  const normalizedKey = normalizeRouteKey(routeKey);
  const routes = getConfiguredRoutes(env);
  const route = routes.find((candidate) => {
    return (
      normalizeRouteKey(candidate.commandPrefix) === normalizedKey ||
      normalizeRouteKey(candidate.project) === normalizedKey
    );
  });

  if (!route) {
    const available = routes
      .map((candidate) => `${candidate.project || "unknown"}:${candidate.commandPrefix || "no-prefix"}`)
      .join(", ");
    throw new Error(`No Slack route matched ${routeKey}. Available routes: ${available}`);
  }

  if ((route.executor || "").trim().toLowerCase() !== "worker") {
    throw new Error(`Route ${route.project || routeKey} executor is not worker`);
  }

  return route;
}

function sanitizeRouteSnapshot(route) {
  return {
    channelId: route.channelId,
    project: route.project,
    executor: route.executor,
    commandPrefix: route.commandPrefix,
    workerQueue: route.workerQueue || "default",
    allowedUserIds: Array.isArray(route.allowedUserIds) ? route.allowedUserIds : [],
    workspace: route.workspace && typeof route.workspace === "object" ? route.workspace : null,
    agent: route.agent && typeof route.agent === "object" ? route.agent : null,
    qa: route.qa && typeof route.qa === "object" ? route.qa : null,
    review: route.review && typeof route.review === "object" ? route.review : null,
    implementation: route.implementation && typeof route.implementation === "object" ? route.implementation : null,
    artifacts: route.artifacts && typeof route.artifacts === "object" ? route.artifacts : null,
    policy: route.policy && typeof route.policy === "object" ? route.policy : null
  };
}

function ensureCommandTextHasSlackPrefix(text, route) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Command text is required");
  if (trimmed.startsWith(ROUTINE_COMMAND_PREFIX)) return trimmed;

  const commandPrefix = String(route.commandPrefix || "").trim();
  if (!commandPrefix) return `${ROUTINE_COMMAND_PREFIX} ${trimmed}`;
  if (trimmed.toLowerCase().startsWith(commandPrefix.toLowerCase())) {
    return `${ROUTINE_COMMAND_PREFIX} ${trimmed}`;
  }
  return `${ROUTINE_COMMAND_PREFIX} ${commandPrefix} ${trimmed}`;
}

async function readCommandText(args) {
  if (args.file) return (await readFile(path.resolve(process.cwd(), args.file), "utf8")).trim();
  if (args.text) return args.text.trim();
  throw new Error("Provide --text or --file");
}

function createFetchSignal(timeoutMs = 5000) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

async function postSlackParentMessage(env, { channel, text }) {
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is required to post Slack parent message");
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ channel, text }),
    signal: createFetchSignal(Number.parseInt(env.SLACK_FETCH_TIMEOUT_MS || "5000", 10))
  });
  if (!response.ok) throw new Error(`Slack chat.postMessage failed with HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`Slack chat.postMessage failed: ${result.error || "unknown_error"}`);
  return result;
}

function buildIdempotencyKey({ env, route, messageTs, text, explicitKey }) {
  if (explicitKey) return explicitKey;
  const teamId = env.SLACK_TEAM_ID || "hermes-direct";
  const digest = crypto.createHash("sha256").update(`${route.project}:${messageTs}:${text}`).digest("hex").slice(0, 16);
  return `${teamId}:hermes-direct:${route.project || route.commandPrefix}:${messageTs}:${digest}`;
}

function buildCommandJobRecord({ env, route, channel, text, messageTs, threadTs, sourceUserId, idempotencyKey }) {
  return {
    idempotency_key: idempotencyKey,
    status: "queued",
    project: route.project,
    executor: route.executor,
    queue: route.workerQueue || env.SLACK_WORKER_QUEUE || "default",
    team_id: env.SLACK_TEAM_ID || null,
    enterprise_id: env.SLACK_ENTERPRISE_ID || null,
    channel_id: channel,
    user_id: sourceUserId,
    event_id: null,
    message_ts: messageTs,
    thread_ts: threadTs,
    command_text: text,
    normalized_command: text.trim(),
    route_snapshot: sanitizeRouteSnapshot(route),
    attempt_count: 0
  };
}

async function insertCommandJob(env, record) {
  const supabaseUrl = (env.COMMAND_JOBS_SUPABASE_URL || "").replace(/\/$/, "");
  const serviceRoleKey = env.COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("COMMAND_JOBS_SUPABASE_URL and COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const tableName = env.COMMAND_JOBS_TABLE || DEFAULT_COMMAND_JOBS_TABLE;
  const url = `${supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(record),
    signal: createFetchSignal(Number.parseInt(env.COMMAND_JOBS_FETCH_TIMEOUT_MS || "5000", 10))
  });

  if (!response.ok) {
    let body = "";
    try { body = await response.text(); } catch {}
    throw new Error(`Command job insert failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  const result = await response.json();
  const job = Array.isArray(result) ? result[0] : result;
  if (!job?.id) throw new Error("Command job insert response did not include id");
  return job;
}

function summarizeRecord(record) {
  return {
    idempotency_key: record.idempotency_key,
    status: record.status,
    project: record.project,
    executor: record.executor,
    queue: record.queue,
    channel_id: record.channel_id,
    user_id: record.user_id,
    message_ts: record.message_ts,
    thread_ts: record.thread_ts,
    command_text: record.command_text,
    route_snapshot: {
      project: record.route_snapshot.project,
      commandPrefix: record.route_snapshot.commandPrefix,
      workerQueue: record.route_snapshot.workerQueue,
      workspace: record.route_snapshot.workspace,
      agentBackend: record.route_snapshot.agent?.backend ?? null
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const fileEnv = await loadDotEnvFile(args.envFile);
  const env = { ...fileEnv, ...process.env };
  const route = findRoute(env, args.route);
  const channel = args.channel || route.channelId;
  if (!channel) throw new Error("Slack channel id is required");

  const rawText = await readCommandText(args);
  const commandText = ensureCommandTextHasSlackPrefix(rawText, route);

  let messageTs = args.messageTs;
  let threadTs = args.threadTs || args.messageTs;
  let slackResult = null;

  if (args.postSlack && !args.dryRun) {
    slackResult = await postSlackParentMessage(env, { channel, text: commandText });
    messageTs = slackResult.ts;
    threadTs = slackResult.ts;
  }

  if (!args.postSlack && (!messageTs || !threadTs)) {
    throw new Error("--no-slack requires --message-ts or --thread-ts so worker replies have a Slack thread target");
  }

  if (args.dryRun) {
    messageTs ||= "DRYRUN.MESSAGE_TS";
    threadTs ||= messageTs;
  }

  const idempotencyKey = buildIdempotencyKey({
    env,
    route,
    messageTs,
    text: commandText,
    explicitKey: args.idempotencyKey
  });
  const record = buildCommandJobRecord({
    env,
    route,
    channel,
    text: commandText,
    messageTs,
    threadTs,
    sourceUserId: args.sourceUserId,
    idempotencyKey
  });

  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, commandJob: summarizeRecord(record) }, null, 2));
    return;
  }

  const job = await insertCommandJob(env, record);
  console.log(JSON.stringify({
    ok: true,
    slack: slackResult ? { channel, ts: slackResult.ts } : { channel, ts: messageTs, skipped: true },
    commandJob: { id: job.id, status: job.status, project: job.project, queue: job.queue, thread_ts: job.thread_ts },
    idempotencyKey
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
