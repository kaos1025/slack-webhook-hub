import { verifySlackRequestSignature } from "./slack-signing.js";

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

function shouldEchoEvent(event, env) {
  return (
    isSlackMessageEvent(event) &&
    event.channel === env.SLACK_ECHO_CHANNEL_ID &&
    !event.bot_id &&
    !event.subtype &&
    typeof event.text === "string" &&
    event.text.trim().length > 0
  );
}

async function maybePostSingleChannelEcho(payload, env, postMessage) {
  const event = payload.event;

  if (!shouldEchoEvent(event, env)) {
    return;
  }

  if (!env.SLACK_BOT_TOKEN) {
    console.warn("Skipping Slack echo because SLACK_BOT_TOKEN is not configured.");
    return;
  }

  await postMessage({
    token: env.SLACK_BOT_TOKEN,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text: `Echo: ${event.text}`
  });
}

export async function postSlackEchoReply({ token, channel, threadTs, text }) {
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
  postMessage = postSlackEchoReply,
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
    void maybePostSingleChannelEcho(payload, env, postMessage).catch((error) => {
      console.error("Slack echo failed:", error);
    });

    return jsonResponse({ ok: true }, { status: 200 });
  }

  return jsonResponse({ ok: true }, { status: 200 });
}
