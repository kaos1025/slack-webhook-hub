import { verifySlackRequestSignature } from "./slack-signing.js";

const ROUTINE_FIRE_BETA_HEADER = "experimental-cc-routine-2026-04-01";
const ROUTINE_FIRE_API_VERSION = "2023-06-01";
const ROUTINE_COMMAND_PREFIX = "클로드,";
const SLACK_MENTION_COMMAND_SEPARATOR_PATTERN = /^(?:\s+|[,，:：]\s*)/;
const DEFAULT_SLACK_EXECUTOR = "routine";
const SUPPORTED_SLACK_EXECUTORS = new Set(["routine", "noop", "worker"]);

function jsonResponse(body, init = {}) {
  return Response.json(body, init);
}

function runTaskImmediately(task) {
  void task();
}

function getHeader(headers, name) {
  if (typeof headers.get === "function") {
    return headers.get(name);
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function isSlackRetryRequest(headers) {
  return getHeader(headers, "x-slack-retry-num") !== null;
}

function normalizeExecutor(executor) {
  return (executor || DEFAULT_SLACK_EXECUTOR).trim().toLowerCase();
}

function normalizeAllowedUserIds(rawRoute) {
  if (!Object.hasOwn(rawRoute, "allowedUserIds")) {
    return [];
  }

  if (!Array.isArray(rawRoute.allowedUserIds)) {
    return null;
  }

  const normalizedUserIds = rawRoute.allowedUserIds.map((userId) =>
    typeof userId === "string" ? userId.trim() : ""
  );

  if (normalizedUserIds.some((userId) => !userId)) {
    return null;
  }

  return normalizedUserIds;
}

function isUserAllowedForRoute(userId, route) {
  return route.allowedUserIds.length === 0 || route.allowedUserIds.includes(userId);
}

function getSlackExecutor(env) {
  return normalizeExecutor(env.SLACK_EXECUTOR);
}

function isSlackMessageEvent(event) {
  return event?.type === "message" && typeof event.channel === "string";
}

function isSlackPrefixCommandText(text) {
  return typeof text === "string" && text.trim().startsWith(ROUTINE_COMMAND_PREFIX);
}

function isSlackBotMentionCommandText(text, env) {
  const botUserId = typeof env.SLACK_BOT_USER_ID === "string" ? env.SLACK_BOT_USER_ID.trim() : "";
  if (!botUserId || typeof text !== "string") {
    return false;
  }

  const trimmedText = text.trim();
  const mention = `<@${botUserId}>`;
  if (!trimmedText.startsWith(mention)) {
    return false;
  }

  const remainder = trimmedText.slice(mention.length);
  if (!SLACK_MENTION_COMMAND_SEPARATOR_PATTERN.test(remainder)) {
    return false;
  }

  return remainder.replace(/^[\s,，:：]+/, "").trim().length > 0;
}

function isSlackCommandText(text, env) {
  return isSlackPrefixCommandText(text) || isSlackBotMentionCommandText(text, env);
}

function getSlackCommandPayload(text, env) {
  if (typeof text !== "string") {
    return "";
  }

  const trimmedText = text.trim();
  if (trimmedText.startsWith(ROUTINE_COMMAND_PREFIX)) {
    return trimmedText.slice(ROUTINE_COMMAND_PREFIX.length).trim();
  }

  const botUserId = typeof env.SLACK_BOT_USER_ID === "string" ? env.SLACK_BOT_USER_ID.trim() : "";
  const mention = botUserId ? `<@${botUserId}>` : "";
  if (mention && trimmedText.startsWith(mention)) {
    return trimmedText.slice(mention.length).replace(/^[\s,，:：]+/, "").trim();
  }

  return trimmedText;
}

function normalizeCommandPrefix(rawPrefix) {
  return typeof rawPrefix === "string" && rawPrefix.trim() ? rawPrefix.trim().toLowerCase() : "";
}

function buildLegacySingleProjectRoute(env) {
  if (!env.SLACK_ROUTINE_CHANNEL_ID) {
    return null;
  }

  return {
    channelId: env.SLACK_ROUTINE_CHANNEL_ID,
    project: env.SLACK_ROUTINE_PROJECT ?? "single routed project",
    executor: getSlackExecutor(env),
    triggerId: env.SLACK_ROUTINE_TRIGGER_ID,
    tokenEnv: "ROUTINE_TOKEN",
    allowedUserIds: [],
    workerQueue: env.SLACK_WORKER_QUEUE || "default"
  };
}

function normalizeRoute(rawRoute) {
  if (!rawRoute || typeof rawRoute !== "object") {
    return null;
  }

  if (typeof rawRoute.channelId !== "string" || !rawRoute.channelId.trim()) {
    return null;
  }

  const allowedUserIds = normalizeAllowedUserIds(rawRoute);
  if (!allowedUserIds) {
    console.error(
      `Ignoring Slack route for ${rawRoute.channelId} because allowedUserIds must be an array of non-empty strings.`
    );
    return null;
  }

  return {
    channelId: rawRoute.channelId.trim(),
    project: typeof rawRoute.project === "string" && rawRoute.project.trim() ? rawRoute.project.trim() : "routed project",
    executor: normalizeExecutor(rawRoute.executor),
    triggerId: typeof rawRoute.triggerId === "string" ? rawRoute.triggerId.trim() : "",
    commandPrefix: normalizeCommandPrefix(rawRoute.commandPrefix),
    tokenEnv: typeof rawRoute.tokenEnv === "string" && rawRoute.tokenEnv.trim() ? rawRoute.tokenEnv.trim() : "ROUTINE_TOKEN",
    allowedUserIds,
    workerQueue:
      typeof rawRoute.workerQueue === "string" && rawRoute.workerQueue.trim() ? rawRoute.workerQueue.trim() : "default",
    workspace: rawRoute.workspace && typeof rawRoute.workspace === "object" ? rawRoute.workspace : null,
    agent: rawRoute.agent && typeof rawRoute.agent === "object" ? rawRoute.agent : null,
    qa: rawRoute.qa && typeof rawRoute.qa === "object" ? rawRoute.qa : null,
    review: rawRoute.review && typeof rawRoute.review === "object" ? rawRoute.review : null,
    implementation: rawRoute.implementation && typeof rawRoute.implementation === "object" ? rawRoute.implementation : null,
    artifacts: rawRoute.artifacts && typeof rawRoute.artifacts === "object" ? rawRoute.artifacts : null,
    policy: rawRoute.policy && typeof rawRoute.policy === "object" ? rawRoute.policy : null
  };
}

function getConfiguredRoutes(env) {
  const legacyRoute = buildLegacySingleProjectRoute(env);

  if (env.SLACK_ROUTES_JSON) {
    let parsedRoutes;
    try {
      parsedRoutes = JSON.parse(env.SLACK_ROUTES_JSON);
    } catch (error) {
      console.error("Ignoring SLACK_ROUTES_JSON because it is invalid JSON:", error);
      return [];
    }

    if (!Array.isArray(parsedRoutes)) {
      console.error("Ignoring SLACK_ROUTES_JSON because it is not an array.");
      return [];
    }

    const configuredRoutes = parsedRoutes.map(normalizeRoute).filter(Boolean);
    return legacyRoute ? [...configuredRoutes, legacyRoute] : configuredRoutes;
  }

  return legacyRoute ? [legacyRoute] : [];
}

function getRouteForEvent(event, env) {
  const channelRoutes = getConfiguredRoutes(env).filter((route) => route.channelId === event.channel);
  if (channelRoutes.length === 0) {
    return null;
  }

  const commandPayload = getSlackCommandPayload(event.text, env).toLowerCase();
  const prefixedRoute = channelRoutes.find(
    (route) => route.commandPrefix && commandPayload.startsWith(route.commandPrefix)
  );
  if (prefixedRoute) {
    return prefixedRoute;
  }

  return channelRoutes.find((route) => !route.commandPrefix) ?? null;
}

function shouldHandleCommandEvent(event, env) {
  return !event.bot_id && !event.subtype && isSlackCommandText(event.text, env);
}

function buildRoutineFireText(payload, route) {
  const event = payload.event;
  const threadTs = event.thread_ts ?? event.ts;

  return [
    `A Slack command was received for ${route.project}.`,
    "",
    `Command text: ${event.text.trim()}`,
    "",
    `Slack team ID: ${payload.team_id ?? "unknown"}.`,
    `Slack enterprise ID: ${payload.enterprise_id ?? "none"}.`,
    `Slack channel ID: ${event.channel}.`,
    `Slack event type: ${event.type}.`,
    `Slack user ID: ${event.user ?? "unknown"}.`,
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`,
    `Slack thread timestamp for replies: ${threadTs ?? "unknown"}.`,
    `Route project: ${route.project}.`,
    `Route executor: ${route.executor}.`,
    "",
    "Use this context to handle the command and continue status updates in the Slack thread when appropriate."
  ].join("\n");
}

function buildNoopExecutorReply(payload, route) {
  const event = payload.event;

  return [
    "Command accepted by slack-webhook-hub, but no executor is active.",
    "",
    `Configured executor: noop.`,
    `Route project: ${route.project}.`,
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`
  ].join("\n");
}

function getThreadTs(event) {
  return event.thread_ts ?? event.ts;
}

function getCommandJobIdempotencyKey(payload) {
  const event = payload.event;
  const teamId = payload.team_id ?? "unknown-team";
  if (payload.event_id) {
    return `${teamId}:event:${payload.event_id}`;
  }

  return `${teamId}:message:${event.channel}:${event.ts ?? "unknown-ts"}`;
}

function buildNormalizedCommandText(event) {
  return typeof event.text === "string" ? event.text.trim() : "";
}

function sanitizeRouteSnapshot(route) {
  return {
    channelId: route.channelId,
    project: route.project,
    executor: route.executor,
    commandPrefix: route.commandPrefix,
    workerQueue: route.workerQueue,
    allowedUserIds: route.allowedUserIds,
    workspace: route.workspace,
    agent: route.agent,
    qa: route.qa,
    review: route.review,
    implementation: route.implementation,
    artifacts: route.artifacts,
    policy: route.policy
  };
}

function buildCommandJobRecord(payload, route) {
  const event = payload.event;

  return {
    idempotency_key: getCommandJobIdempotencyKey(payload),
    status: "queued",
    project: route.project,
    executor: route.executor,
    queue: route.workerQueue,
    team_id: payload.team_id ?? null,
    enterprise_id: payload.enterprise_id ?? null,
    channel_id: event.channel,
    user_id: event.user ?? null,
    event_id: payload.event_id ?? null,
    message_ts: event.ts ?? null,
    thread_ts: getThreadTs(event),
    command_text: event.text ?? "",
    normalized_command: buildNormalizedCommandText(event),
    route_snapshot: sanitizeRouteSnapshot(route),
    attempt_count: 0
  };
}

function getCommandJobsTableName(env) {
  return env.COMMAND_JOBS_TABLE || "command_jobs";
}

function getSupabaseRestBaseUrl(env) {
  return env.COMMAND_JOBS_SUPABASE_URL?.replace(/\/$/, "") || "";
}

function buildSupabaseInsertUrl(env, tableName) {
  const supabaseUrl = getSupabaseRestBaseUrl(env);
  if (!supabaseUrl) {
    return "";
  }

  return `${supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}`;
}

function buildSupabaseLookupUrl(env, tableName, idempotencyKey) {
  const supabaseUrl = getSupabaseRestBaseUrl(env);
  if (!supabaseUrl) {
    return "";
  }

  return `${supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,idempotency_key,status`;
}

function getCommandJobsFetchTimeoutMs(env) {
  const timeoutMs = Number.parseInt(env.COMMAND_JOBS_FETCH_TIMEOUT_MS || "2500", 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2500;
}

function createCommandJobsFetchSignal(env) {
  const timeoutMs = getCommandJobsFetchTimeoutMs(env);
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}

async function fetchCommandJobJson(url, options, env) {
  return fetch(url, {
    ...options,
    signal: createCommandJobsFetchSignal(env)
  });
}

async function lookupExistingCommandJob(env, tableName, serviceRoleKey, idempotencyKey) {
  const lookupUrl = buildSupabaseLookupUrl(env, tableName, idempotencyKey);
  const response = await fetchCommandJobJson(
    lookupUrl,
    {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json"
      }
    },
    env
  );

  if (!response.ok) {
    throw new Error(`Command job duplicate lookup failed with HTTP ${response.status}`);
  }

  const result = await response.json();
  const job = Array.isArray(result) ? result[0] : result;
  if (!job?.id) {
    throw new Error("Command job duplicate lookup did not return an existing job");
  }

  return {
    id: job.id,
    idempotencyKey: job.idempotency_key ?? idempotencyKey,
    isDuplicate: true
  };
}

async function enqueueCommandJob(payload, env, route) {
  const tableName = getCommandJobsTableName(env);
  const insertUrl = buildSupabaseInsertUrl(env, tableName);
  const serviceRoleKey = env.COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY;
  if (!insertUrl || !serviceRoleKey) {
    throw new Error(
      "Worker executor persistence is not configured. Set COMMAND_JOBS_SUPABASE_URL and COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  const idempotencyKey = getCommandJobIdempotencyKey(payload);
  const response = await fetchCommandJobJson(
    insertUrl,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(buildCommandJobRecord(payload, route))
    },
    env
  );

  if (response.status === 409) {
    return lookupExistingCommandJob(env, tableName, serviceRoleKey, idempotencyKey);
  }

  if (!response.ok) {
    throw new Error(`Command job persistence failed with HTTP ${response.status}`);
  }

  const result = await response.json();
  const job = Array.isArray(result) ? result[0] : result;
  if (!job?.id) {
    throw new Error("Command job persistence response did not include id");
  }

  return {
    id: job.id,
    idempotencyKey: job.idempotency_key ?? idempotencyKey,
    isDuplicate: false
  };
}

function buildWorkerQueuedReply(payload, route, job) {
  const event = payload.event;

  return [
    `Command queued by slack-webhook-hub for ${route.project}.`,
    "",
    `Configured executor: worker.`,
    `Route project: ${route.project}.`,
    `Worker queue: ${route.workerQueue}.`,
    `Command job ID: ${job.id}.`,
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`
  ].join("\n");
}

function buildWorkerPersistenceErrorResponse(error) {
  const errorMessage = error instanceof Error ? error.message : "unknown persistence error";
  console.error("Worker command job persistence failed before Slack ack:", error);
  return jsonResponse(
    {
      error: "worker_persistence_unavailable",
      message: errorMessage
    },
    { status: 503 }
  );
}

function buildUnsupportedExecutorReply(payload, route) {
  const event = payload.event;

  return [
    `Command accepted by slack-webhook-hub, but executor=${route.executor} is not supported for route ${route.project}.`,
    "Configure route executor=routine, route executor=noop, or route executor=worker.",
    "",
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`
  ].join("\n");
}

function buildUnauthorizedUserReply(payload, route) {
  const event = payload.event;

  return [
    `Command rejected by slack-webhook-hub because this user is not allowed for ${route.project}.`,
    "",
    `Route project: ${route.project}.`,
    `Slack user ID: ${event.user ?? "unknown"}.`,
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`
  ].join("\n");
}

function buildRoutineAcceptedReply(payload, route) {
  const event = payload.event;

  return [
    `Command accepted by slack-webhook-hub; firing routine for ${route.project}.`,
    "",
    `Configured executor: routine.`,
    `Route project: ${route.project}.`,
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`
  ].join("\n");
}

function buildRoutineConfigErrorReply(payload, route, message) {
  const event = payload.event;

  return [
    `Command accepted by slack-webhook-hub, but routine is not configured for ${route.project}.`,
    message,
    "",
    `Configured executor: routine.`,
    `Route project: ${route.project}.`,
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`
  ].join("\n");
}

function buildRoutineFailedReply(payload, route, error) {
  const event = payload.event;
  const errorMessage = error instanceof Error ? error.message : "unknown error";

  return [
    `Routine fire failed for ${route.project}.`,
    errorMessage,
    "",
    `Configured executor: routine.`,
    `Route project: ${route.project}.`,
    `Slack event ID: ${payload.event_id ?? "unknown"}.`,
    `Slack message timestamp: ${event.ts ?? "unknown"}.`
  ].join("\n");
}

async function postCommandStatusReply(payload, env, postMessage, text) {
  const event = payload.event;

  if (!env.SLACK_BOT_TOKEN) {
    console.warn("Skipping Slack command status reply because SLACK_BOT_TOKEN is not configured.");
    return;
  }

  await postMessage({
    token: env.SLACK_BOT_TOKEN,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text
  });
}

async function executeRoutineBackend(payload, env, route, fireRoutine, postMessage) {
  const event = payload.event;

  if (!env.SLACK_BOT_TOKEN) {
    console.warn("Skipping Slack routine fire because SLACK_BOT_TOKEN is not configured.");
    return;
  }

  if (!route.triggerId) {
    const message = `Route triggerId is not configured for ${route.project}.`;
    console.warn(`Skipping Slack routine fire for ${route.project} because triggerId is not configured.`);
    await postCommandStatusReply(payload, env, postMessage, buildRoutineConfigErrorReply(payload, route, message));
    return;
  }

  const routineToken = env[route.tokenEnv];
  if (!routineToken) {
    const message = `Route tokenEnv points to ${route.tokenEnv}, but that environment variable is not configured.`;
    console.warn(
      `Skipping Slack routine fire for ${route.project} because ${route.tokenEnv} is not configured.`
    );
    await postCommandStatusReply(payload, env, postMessage, buildRoutineConfigErrorReply(payload, route, message));
    return;
  }

  await postCommandStatusReply(payload, env, postMessage, buildRoutineAcceptedReply(payload, route));

  try {
    const routineResult = await fireRoutine({
      token: routineToken,
      triggerId: route.triggerId,
      text: buildRoutineFireText(payload, route)
    });

    await postMessage({
      token: env.SLACK_BOT_TOKEN,
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      text: `Routine fired for ${route.project}: ${routineResult.claude_code_session_url}`
    });
  } catch (error) {
    console.error(`Slack routine fire failed for ${route.project}:`, error);
    await postCommandStatusReply(payload, env, postMessage, buildRoutineFailedReply(payload, route, error));
  }
}

async function prepareSlackCommandBeforeAck(payload, env, enqueueJob) {
  const event = payload.event;

  if (!isSlackMessageEvent(event)) {
    return { workerJob: null };
  }

  const route = getRouteForEvent(event, env);
  if (!route || route.executor !== "worker") {
    return { workerJob: null };
  }

  if (!shouldHandleCommandEvent(event, env) || !isUserAllowedForRoute(event.user, route)) {
    return { workerJob: null };
  }

  try {
    const workerJob = await enqueueJob(payload, env, route);
    return { workerJob };
  } catch (error) {
    return { response: buildWorkerPersistenceErrorResponse(error) };
  }
}

async function executeSlackCommand(payload, env, fireRoutine, postMessage, preAck = {}) {
  const event = payload.event;

  if (!isSlackMessageEvent(event)) {
    return;
  }

  const route = getRouteForEvent(event, env);
  if (!route) {
    return;
  }

  if (!shouldHandleCommandEvent(event, env)) {
    return;
  }

  if (!isUserAllowedForRoute(event.user, route)) {
    await postCommandStatusReply(payload, env, postMessage, buildUnauthorizedUserReply(payload, route));
    return;
  }

  if (!SUPPORTED_SLACK_EXECUTORS.has(route.executor)) {
    await postCommandStatusReply(payload, env, postMessage, buildUnsupportedExecutorReply(payload, route));
    return;
  }

  if (route.executor === "noop") {
    await postCommandStatusReply(payload, env, postMessage, buildNoopExecutorReply(payload, route));
    return;
  }

  if (route.executor === "worker") {
    if (!preAck.workerJob) {
      console.warn("Skipping worker queued reply because no pre-ack command job was provided.");
      return;
    }

    if (!preAck.workerJob.isDuplicate) {
      await postCommandStatusReply(payload, env, postMessage, buildWorkerQueuedReply(payload, route, preAck.workerJob));
    }
    return;
  }

  await executeRoutineBackend(payload, env, route, fireRoutine, postMessage);
}

export async function fireClaudeRoutine({ token, triggerId, text }) {
  const response = await fetch(
    `https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(triggerId)}/fire`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": ROUTINE_FIRE_BETA_HEADER,
        "anthropic-version": ROUTINE_FIRE_API_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    }
  );

  if (!response.ok) {
    throw new Error(`Claude routine fire failed with HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result.claude_code_session_url) {
    throw new Error("Claude routine fire response did not include claude_code_session_url");
  }

  return result;
}

export async function postSlackThreadReply({ token, channel, threadTs, text }) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs
    })
  });

  if (!response.ok) {
    throw new Error(`Slack Web API request failed with HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Slack Web API request failed: ${result.error ?? "unknown_error"}`);
  }
}

export async function handleSlackEventsRequest({
  rawBody,
  headers,
  env,
  fireRoutine = fireClaudeRoutine,
  postMessage = postSlackThreadReply,
  enqueueJob = enqueueCommandJob,
  runAfter = runTaskImmediately,
  nowSeconds = undefined
}) {
  if (!env.SLACK_SIGNING_SECRET) {
    return jsonResponse({ error: "SLACK_SIGNING_SECRET is not configured" }, { status: 500 });
  }

  const timestamp = getHeader(headers, "x-slack-request-timestamp");
  const signature = getHeader(headers, "x-slack-signature");
  const verified = verifySlackRequestSignature({
    signingSecret: env.SLACK_SIGNING_SECRET,
    rawBody,
    timestamp,
    signature,
    nowSeconds
  });

  if (!verified) {
    return jsonResponse({ error: "invalid Slack signature" }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, { status: 400 });
  }

  if (payload.type === "url_verification") {
    return new Response(payload.challenge ?? "", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  if (payload.type === "event_callback") {
    const preAck = await prepareSlackCommandBeforeAck(payload, env, enqueueJob);
    if (preAck.response) {
      return preAck.response;
    }

    if (isSlackRetryRequest(headers) && !preAck.workerJob) {
      console.warn(
        `Ignoring Slack retry request: retry_num=${getHeader(headers, "x-slack-retry-num")}, retry_reason=${getHeader(headers, "x-slack-retry-reason") ?? "unknown"}`
      );
      return jsonResponse({ ok: true, ignored: "slack_retry" }, { status: 200 });
    }

    const execute = () =>
      executeSlackCommand(payload, env, fireRoutine, postMessage, preAck).catch((error) => {
        console.error("Slack command execution failed:", error);
      });

    if (typeof runAfter === "function") {
      runAfter(execute);
    } else {
      void execute();
    }

    return jsonResponse({ ok: true }, { status: 200 });
  }

  return jsonResponse({ ok: true }, { status: 200 });
}
