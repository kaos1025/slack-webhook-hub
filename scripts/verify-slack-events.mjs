import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { handleSlackEventsRequest } from "../src/lib/slack-events.js";
import { createSlackSignature } from "../src/lib/slack-signing.js";

const signingSecret = "test-signing-secret";
const echoChannel = "C_ECHO";
const nowSeconds = 1_800_000_000;

function signedHeaders(rawBody, timestamp = String(nowSeconds)) {
  return new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": createSlackSignature({
      signingSecret,
      timestamp,
      rawBody
    })
  });
}

async function call(payload, options = {}) {
  const rawBody = JSON.stringify(payload);
  const calls = [];
  const response = await handleSlackEventsRequest({
    rawBody,
    headers: options.headers ?? signedHeaders(rawBody),
    env: {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_ECHO_CHANNEL_ID: echoChannel
    },
    postMessage: async (message) => {
      calls.push(message);
    },
    nowSeconds
  });

  await waitImmediate();
  return { response, calls };
}

const challenge = await call({
  type: "url_verification",
  challenge: "challenge-token"
});
assert.equal(challenge.response.status, 200);
assert.equal(await challenge.response.text(), "challenge-token");
assert.equal(challenge.calls.length, 0);

const ack = await call({
  type: "event_callback",
  event_id: "Ev1",
  event: {
    type: "message",
    channel: echoChannel,
    user: "U1",
    text: "hello",
    ts: "1710000000.000100"
  }
});
assert.equal(ack.response.status, 200);
assert.deepEqual(await ack.response.json(), { ok: true });
assert.equal(ack.calls.length, 1);
assert.equal(ack.calls[0].channel, echoChannel);
assert.equal(ack.calls[0].threadTs, "1710000000.000100");
assert.equal(ack.calls[0].text, "Echo: hello");

const skipped = await call({
  type: "event_callback",
  event_id: "Ev2",
  event: {
    type: "message",
    channel: "C_OTHER",
    user: "U1",
    text: "hello",
    ts: "1710000000.000200"
  }
});
assert.equal(skipped.response.status, 200);
assert.equal(skipped.calls.length, 0);

const staleRawBody = JSON.stringify({ type: "event_callback", event: {} });
const staleTimestamp = String(nowSeconds - 301);
const stale = await handleSlackEventsRequest({
  rawBody: staleRawBody,
  headers: signedHeaders(staleRawBody, staleTimestamp),
  env: {
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_ECHO_CHANNEL_ID: echoChannel
  },
  nowSeconds
});
assert.equal(stale.status, 401);

const invalidRawBody = JSON.stringify({ type: "url_verification", challenge: "nope" });
const invalid = await handleSlackEventsRequest({
  rawBody: invalidRawBody,
  headers: new Headers({
    "x-slack-request-timestamp": String(nowSeconds),
    "x-slack-signature": "v0=bad"
  }),
  env: {
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_ECHO_CHANNEL_ID: echoChannel
  },
  nowSeconds
});
assert.equal(invalid.status, 401);

console.log("Slack event verifier passed.");
