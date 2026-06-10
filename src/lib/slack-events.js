import { verifySlackRequestSignature } from "./slack-signing.js";

const ROUTINE_FIRE_BETA_HEADER = "experimental-cc-routine-2026-04-01";
const ROUTINE_FIRE_API_VERSION = "2023-06-01";
const ROUTINE_COMMAND_PREFIX = "클로드,";

function jsonResponse(body, init = {}) {
  return Response.json(body, init);
}

function getHeader(headers, name) {
  if (typeof headers.get === "function") {
    return headers.get(name);
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function isSlackMessageEvent(event) {
  return event?.type === "message" && typeof event.channel === "string";
}

function isSlackCommandText(text) {
  return typeof text === "string" && text.trim().startsWith(ROUTINE_COMMAND_PREFIX);
}

function getSingleProjectRoutineRoute(channel, env) {
  if (!env.SLACK_ROUTINE_CHANNEL_ID || !env.SLACK_ROUTINE_TRIGGER_ID) {
    return null;
  }

  if (channel !== env.SLACK_ROUTINE_CHANNEL_ID) {
    return null;
  }

  return {
    channelId: env.SLACK_ROUTINE_CHANNEL_ID,
    triggerId: env.SLACK_ROUTINE_TRIGGER_ID
  };
}

function shouldFireRoutineForEvent(event, env) {
  return (
    isSlackMessageEvent(event) &&
    getSingleProjectRoutineRoute(event.channel, env) &&
    !event.bot_id &&
    !event.subtype &&
    isSlackCommandText(event.text)
  );
}

function buildRoutineFireText(payload) {
  const event = payload.event;
  const threadTs = event.thread_ts ?? event.ts;

  return [
    "A Slack command was received for the single routed project.",
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
    "",
    "Use this context to handle the command and continue status updates in the Slack thread when appropriate."
  ].join("\n");
}

async function maybeFireSingleProjectRoutine(payload, env, fireRoutine, postMessage) {
  const event = payload.event;

  if (!isSlackMessageEvent(event)) {
    return;
  }

  if (!env.SLACK_ROUTINE_CHANNEL_ID || !env.SLACK_ROUTINE_TRIGGER_ID) {
    console.warn("Skipping Slack routine fire because routine routing is not configured.");
    return;
  }

  if (!shouldFireRoutineForEvent(event, env)) {
    return;
  }

  if (!env.SLACK_BOT_TOKEN) {
    console.warn("Skipping Slack routine fire because SLACK_BOT_TOKEN is not configured.");
    return;
  }

  if (!env.ROUTINE_TOKEN) {
    console.warn("Skipping Slack routine fire because ROUTINE_TOKEN is not configured.");
    return;
  }

  const route = getSingleProjectRoutineRoute(event.channel, env);
  const routineResult = await fireRoutine({
    token: env.ROUTINE_TOKEN,
    triggerId: route.triggerId,
    text: buildRoutineFireText(payload)
  });

  await postMessage({
    token: env.SLACK_BOT_TOKEN,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text: `Routine fired: ${routineResult.claude_code_session_url}`
  });
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
    void maybeFireSingleProjectRoutine(payload, env, fireRoutine, postMessage).catch((error) => {
      console.error("Slack routine fire failed:", error);
    });

    return jsonResponse({ ok: true }, { status: 200 });
  }

  return jsonResponse({ ok: true }, { status: 200 });
}
