import { verifySlackRequestSignature } from "./slack-signing.js";

const ROUTINE_FIRE_BETA_HEADER = "experimental-cc-routine-2026-04-01";
const ROUTINE_FIRE_API_VERSION = "2023-06-01";
const ROUTINE_COMMAND_PREFIX = "클로드,";
const DEFAULT_SLACK_EXECUTOR = "routine";
const SUPPORTED_SLACK_EXECUTORS = new Set(["routine", "noop"]);

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

function isSlackCommandText(text) {
  return typeof text === "string" && text.trim().startsWith(ROUTINE_COMMAND_PREFIX);
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
    allowedUserIds: []
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
    tokenEnv: typeof rawRoute.tokenEnv === "string" && rawRoute.tokenEnv.trim() ? rawRoute.tokenEnv.trim() : "ROUTINE_TOKEN",
    allowedUserIds
  };
}

function getConfiguredRoutes(env) {
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

    return parsedRoutes.map(normalizeRoute).filter(Boolean);
  }

  const legacyRoute = buildLegacySingleProjectRoute(env);
  return legacyRoute ? [legacyRoute] : [];
}

function getRouteForChannel(channel, env) {
  return getConfiguredRoutes(env).find((route) => route.channelId === channel) ?? null;
}

function shouldHandleCommandEvent(event) {
  return !event.bot_id && !event.subtype && isSlackCommandText(event.text);
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

function buildUnsupportedExecutorReply(payload, route) {
  const event = payload.event;

  return [
    `Command accepted by slack-webhook-hub, but executor=${route.executor} is not supported for route ${route.project}.`,
    "Configure route executor=routine or route executor=noop.",
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

async function executeSlackCommand(payload, env, fireRoutine, postMessage) {
  const event = payload.event;

  if (!isSlackMessageEvent(event)) {
    return;
  }

  const route = getRouteForChannel(event.channel, env);
  if (!route) {
    return;
  }

  if (!shouldHandleCommandEvent(event)) {
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

  if (isSlackRetryRequest(headers)) {
    console.warn(
      `Ignoring Slack retry request: retry_num=${getHeader(headers, "x-slack-retry-num")}, retry_reason=${getHeader(headers, "x-slack-retry-reason") ?? "unknown"}`
    );
    return jsonResponse({ ok: true, ignored: "slack_retry" }, { status: 200 });
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
    const execute = () =>
      executeSlackCommand(payload, env, fireRoutine, postMessage).catch((error) => {
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
