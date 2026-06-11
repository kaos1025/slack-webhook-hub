import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import {
  fireClaudeRoutine,
  handleSlackEventsRequest
} from "../src/lib/slack-events.js";
import { createSlackSignature } from "../src/lib/slack-signing.js";

const signingSecret = "test-signing-secret";
const routineChannel = "C_ROUTINE";
const routineTriggerId = "trig_test";
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
  const routineCalls = [];
  const slackCalls = [];
  const response = await handleSlackEventsRequest({
    rawBody,
    headers: options.headers ?? signedHeaders(rawBody),
    env: {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_EXECUTOR: "routine",
      ROUTINE_TOKEN: "routine-token-test",
      SLACK_ROUTINE_CHANNEL_ID: routineChannel,
      SLACK_ROUTINE_TRIGGER_ID: routineTriggerId,
      ...options.env
    },
    fireRoutine: async (routine) => {
      routineCalls.push(routine);
      if (options.fireRoutine) {
        return options.fireRoutine(routine);
      }

      return {
        claude_code_session_id: "session-test",
        claude_code_session_url: "https://claude.ai/code/session-test"
      };
    },
    postMessage: async (message) => {
      slackCalls.push(message);
    },
    nowSeconds
  });

  await waitImmediate();
  return { response, routineCalls, slackCalls };
}

const challenge = await call({
  type: "url_verification",
  challenge: "challenge-token"
});
assert.equal(challenge.response.status, 200);
assert.equal(await challenge.response.text(), "challenge-token");
assert.equal(challenge.routineCalls.length, 0);
assert.equal(challenge.slackCalls.length, 0);

const ack = await call({
  type: "event_callback",
  event_id: "Ev1",
  team_id: "T1",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "클로드, hello",
    ts: "1710000000.000100"
  }
});
assert.equal(ack.response.status, 200);
assert.deepEqual(await ack.response.json(), { ok: true });
assert.equal(ack.routineCalls.length, 1);
assert.equal(ack.routineCalls[0].token, "routine-token-test");
assert.equal(ack.routineCalls[0].triggerId, routineTriggerId);
assert.equal(typeof ack.routineCalls[0].text, "string");
assert.match(ack.routineCalls[0].text, /A Slack command was received/);
assert.match(ack.routineCalls[0].text, /Command text: 클로드, hello/);
assert.match(ack.routineCalls[0].text, /Slack channel ID: C_ROUTINE/);
assert.match(ack.routineCalls[0].text, /Route project: single routed project/);
assert.doesNotMatch(ack.routineCalls[0].text, /^\{/);
assert.equal(ack.slackCalls.length, 2);
assert.equal(ack.slackCalls[0].channel, routineChannel);
assert.equal(ack.slackCalls[0].threadTs, "1710000000.000100");
assert.match(ack.slackCalls[0].text, /firing routine for single routed project/);
assert.equal(ack.slackCalls[1].channel, routineChannel);
assert.equal(ack.slackCalls[1].threadTs, "1710000000.000100");
assert.equal(
  ack.slackCalls[1].text,
  "Routine fired for single routed project: https://claude.ai/code/session-test"
);

const retryRawBody = JSON.stringify({
  type: "event_callback",
  event_id: "EvRetry",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "클로드, retry should be ignored",
    ts: "1710000000.000099"
  }
});
const retryHeaders = signedHeaders(retryRawBody);
retryHeaders.set("x-slack-retry-num", "1");
retryHeaders.set("x-slack-retry-reason", "http_timeout");
const retry = await handleSlackEventsRequest({
  rawBody: retryRawBody,
  headers: retryHeaders,
  env: {
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_TOKEN: "xoxb-test",
    ROUTINE_TOKEN: "routine-token-test",
    SLACK_ROUTINE_CHANNEL_ID: routineChannel,
    SLACK_ROUTINE_TRIGGER_ID: routineTriggerId
  },
  fireRoutine: async () => {
    throw new Error("retry request should not fire routine");
  },
  postMessage: async () => {
    throw new Error("retry request should not post to Slack");
  },
  runAfter: () => {
    throw new Error("retry request should not schedule background work");
  },
  nowSeconds
});
assert.equal(retry.status, 200);
assert.deepEqual(await retry.json(), { ok: true, ignored: "slack_retry" });

const defaultRoutine = await call(
  {
    type: "event_callback",
    event_id: "Ev1Default",
    team_id: "T1",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "클로드, default executor",
      ts: "1710000000.000101"
    }
  },
  {
    env: {
      SLACK_EXECUTOR: ""
    }
  }
);
assert.equal(defaultRoutine.response.status, 200);
assert.equal(defaultRoutine.routineCalls.length, 1);
assert.equal(defaultRoutine.slackCalls.length, 2);
assert.equal(
  defaultRoutine.slackCalls[1].text,
  "Routine fired for single routed project: https://claude.ai/code/session-test"
);

const noop = await call(
  {
    type: "event_callback",
    event_id: "EvNoop",
    team_id: "T1",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "클로드, accept only",
      ts: "1710000000.000102"
    }
  },
  {
    env: {
      SLACK_EXECUTOR: "noop",
      ROUTINE_TOKEN: "",
      SLACK_ROUTINE_TRIGGER_ID: ""
    }
  }
);
assert.equal(noop.response.status, 200);
assert.equal(noop.routineCalls.length, 0);
assert.equal(noop.slackCalls.length, 1);
assert.equal(noop.slackCalls[0].channel, routineChannel);
assert.equal(noop.slackCalls[0].threadTs, "1710000000.000102");
assert.match(noop.slackCalls[0].text, /Command accepted by slack-webhook-hub/);
assert.match(noop.slackCalls[0].text, /Configured executor: noop/);
assert.match(noop.slackCalls[0].text, /Route project: single routed project/);

const unknownExecutor = await call(
  {
    type: "event_callback",
    event_id: "EvUnknownExecutor",
    team_id: "T1",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "클로드, unsupported executor",
      ts: "1710000000.000103"
    }
  },
  {
    env: {
      SLACK_EXECUTOR: "bogus"
    }
  }
);
assert.equal(unknownExecutor.response.status, 200);
assert.equal(unknownExecutor.routineCalls.length, 0);
assert.equal(unknownExecutor.slackCalls.length, 1);
assert.equal(unknownExecutor.slackCalls[0].threadTs, "1710000000.000103");
assert.match(unknownExecutor.slackCalls[0].text, /executor=bogus is not supported/);

const skipped = await call({
  type: "event_callback",
  event_id: "Ev2",
  event: {
    type: "message",
    channel: "C_OTHER",
    user: "U1",
    text: "클로드, hello",
    ts: "1710000000.000200"
  }
});
assert.equal(skipped.response.status, 200);
assert.equal(skipped.routineCalls.length, 0);
assert.equal(skipped.slackCalls.length, 0);

const missingConfig = await call(
  {
    type: "event_callback",
    event_id: "Ev3",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "클로드, hello",
      ts: "1710000000.000300"
    }
  },
  {
    env: {
      SLACK_ROUTINE_TRIGGER_ID: ""
    }
  }
);
assert.equal(missingConfig.response.status, 200);
assert.equal(missingConfig.routineCalls.length, 0);
assert.equal(missingConfig.slackCalls.length, 1);
assert.match(missingConfig.slackCalls[0].text, /routine is not configured/);
assert.match(missingConfig.slackCalls[0].text, /triggerId is not configured/);

const missingToken = await call(
  {
    type: "event_callback",
    event_id: "EvMissingToken",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "클로드, hello",
      ts: "1710000000.000301"
    }
  },
  {
    env: {
      ROUTINE_TOKEN: ""
    }
  }
);
assert.equal(missingToken.response.status, 200);
assert.equal(missingToken.routineCalls.length, 0);
assert.equal(missingToken.slackCalls.length, 1);
assert.match(missingToken.slackCalls[0].text, /routine is not configured/);
assert.match(missingToken.slackCalls[0].text, /ROUTINE_TOKEN/);

const routineFailure = await call(
  {
    type: "event_callback",
    event_id: "EvRoutineFailure",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "클로드, fail routine",
      ts: "1710000000.000302"
    }
  },
  {
    fireRoutine: async () => {
      throw new Error("Claude routine fire failed with HTTP 401");
    }
  }
);
assert.equal(routineFailure.response.status, 200);
assert.equal(routineFailure.routineCalls.length, 1);
assert.equal(routineFailure.slackCalls.length, 2);
assert.match(routineFailure.slackCalls[0].text, /firing routine/);
assert.match(routineFailure.slackCalls[1].text, /Routine fire failed/);
assert.match(routineFailure.slackCalls[1].text, /HTTP 401/);

const threadReply = await call({
  type: "event_callback",
  event_id: "Ev4",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "클로드, continue",
    ts: "1710000000.000400",
    thread_ts: "1710000000.000100"
  }
});
assert.equal(threadReply.response.status, 200);
assert.equal(threadReply.routineCalls.length, 1);
assert.equal(threadReply.slackCalls.length, 2);
assert.equal(threadReply.slackCalls[0].threadTs, "1710000000.000100");
assert.equal(threadReply.slackCalls[1].threadTs, "1710000000.000100");
assert.equal(
  threadReply.slackCalls[1].text,
  "Routine fired for single routed project: https://claude.ai/code/session-test"
);

const routesJson = JSON.stringify([
  {
    channelId: "C_ALPHA",
    project: "alpha",
    executor: "routine",
    triggerId: "trig_alpha",
    tokenEnv: "ROUTINE_TOKEN_ALPHA",
    allowedUserIds: ["U1", "U_ALLOWED"]
  },
  {
    channelId: "C_BETA",
    project: "beta",
    executor: "noop"
  },
  {
    channelId: "C_DELTA",
    project: "delta",
    executor: "noop",
    allowedUserIds: []
  },
  {
    channelId: "C_MALFORMED",
    project: "malformed",
    executor: "noop",
    allowedUserIds: "U1"
  }
]);

const multiRoutine = await call(
  {
    type: "event_callback",
    event_id: "EvMultiRoutine",
    team_id: "T1",
    event: {
      type: "message",
      channel: "C_ALPHA",
      user: "U1",
      text: "클로드, alpha task",
      ts: "1710000000.000500"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: "",
      SLACK_ROUTINE_TRIGGER_ID: "",
      ROUTINE_TOKEN: "",
      ROUTINE_TOKEN_ALPHA: "routine-token-alpha"
    }
  }
);
assert.equal(multiRoutine.response.status, 200);
assert.equal(multiRoutine.routineCalls.length, 1);
assert.equal(multiRoutine.routineCalls[0].token, "routine-token-alpha");
assert.equal(multiRoutine.routineCalls[0].triggerId, "trig_alpha");
assert.match(multiRoutine.routineCalls[0].text, /Route project: alpha/);
assert.equal(multiRoutine.slackCalls.length, 2);
assert.match(multiRoutine.slackCalls[0].text, /firing routine for alpha/);
assert.equal(
  multiRoutine.slackCalls[1].text,
  "Routine fired for alpha: https://claude.ai/code/session-test"
);

const multiUnauthorizedUser = await call(
  {
    type: "event_callback",
    event_id: "EvMultiUnauthorizedUser",
    team_id: "T1",
    event: {
      type: "message",
      channel: "C_ALPHA",
      user: "U_DENIED",
      text: "클로드, alpha unauthorized task",
      ts: "1710000000.000550"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: "",
      SLACK_ROUTINE_TRIGGER_ID: "",
      ROUTINE_TOKEN: "",
      ROUTINE_TOKEN_ALPHA: "routine-token-alpha"
    }
  }
);
assert.equal(multiUnauthorizedUser.response.status, 200);
assert.equal(multiUnauthorizedUser.routineCalls.length, 0);
assert.equal(multiUnauthorizedUser.slackCalls.length, 1);
assert.match(multiUnauthorizedUser.slackCalls[0].text, /not allowed for alpha/);
assert.match(multiUnauthorizedUser.slackCalls[0].text, /Slack user ID: U_DENIED/);

const multiNoop = await call(
  {
    type: "event_callback",
    event_id: "EvMultiNoop",
    team_id: "T1",
    event: {
      type: "message",
      channel: "C_BETA",
      user: "U1",
      text: "클로드, beta task",
      ts: "1710000000.000600"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: ""
    }
  }
);
assert.equal(multiNoop.response.status, 200);
assert.equal(multiNoop.routineCalls.length, 0);
assert.equal(multiNoop.slackCalls.length, 1);
assert.match(multiNoop.slackCalls[0].text, /Configured executor: noop/);
assert.match(multiNoop.slackCalls[0].text, /Route project: beta/);

const multiEmptyAllowlist = await call(
  {
    type: "event_callback",
    event_id: "EvMultiEmptyAllowlist",
    team_id: "T1",
    event: {
      type: "message",
      channel: "C_DELTA",
      user: "U_ANY",
      text: "클로드, delta task",
      ts: "1710000000.000650"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: ""
    }
  }
);
assert.equal(multiEmptyAllowlist.response.status, 200);
assert.equal(multiEmptyAllowlist.routineCalls.length, 0);
assert.equal(multiEmptyAllowlist.slackCalls.length, 1);
assert.match(multiEmptyAllowlist.slackCalls[0].text, /Route project: delta/);

const multiMalformedAllowlist = await call(
  {
    type: "event_callback",
    event_id: "EvMultiMalformedAllowlist",
    team_id: "T1",
    event: {
      type: "message",
      channel: "C_MALFORMED",
      user: "U1",
      text: "클로드, malformed task",
      ts: "1710000000.000660"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: ""
    }
  }
);
assert.equal(multiMalformedAllowlist.response.status, 200);
assert.equal(multiMalformedAllowlist.routineCalls.length, 0);
assert.equal(multiMalformedAllowlist.slackCalls.length, 0);

const multiUnrouted = await call(
  {
    type: "event_callback",
    event_id: "EvMultiUnrouted",
    team_id: "T1",
    event: {
      type: "message",
      channel: "C_GAMMA",
      user: "U1",
      text: "클로드, gamma task",
      ts: "1710000000.000700"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: ""
    }
  }
);
assert.equal(multiUnrouted.response.status, 200);
assert.equal(multiUnrouted.routineCalls.length, 0);
assert.equal(multiUnrouted.slackCalls.length, 0);

const staleRawBody = JSON.stringify({ type: "event_callback", event: {} });
const staleTimestamp = String(nowSeconds - 301);
const stale = await handleSlackEventsRequest({
  rawBody: staleRawBody,
  headers: signedHeaders(staleRawBody, staleTimestamp),
  env: {
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_TOKEN: "xoxb-test",
    ROUTINE_TOKEN: "routine-token-test",
    SLACK_ROUTINE_CHANNEL_ID: routineChannel,
    SLACK_ROUTINE_TRIGGER_ID: routineTriggerId
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
    ROUTINE_TOKEN: "routine-token-test",
    SLACK_ROUTINE_CHANNEL_ID: routineChannel,
    SLACK_ROUTINE_TRIGGER_ID: routineTriggerId
  },
  nowSeconds
});
assert.equal(invalid.status, 401);

const invalidRetry = await handleSlackEventsRequest({
  rawBody: invalidRawBody,
  headers: new Headers({
    "x-slack-request-timestamp": String(nowSeconds),
    "x-slack-signature": "v0=bad",
    "x-slack-retry-num": "1",
    "x-slack-retry-reason": "http_timeout"
  }),
  env: {
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_TOKEN: "xoxb-test",
    ROUTINE_TOKEN: "routine-token-test",
    SLACK_ROUTINE_CHANNEL_ID: routineChannel,
    SLACK_ROUTINE_TRIGGER_ID: routineTriggerId
  },
  nowSeconds
});
assert.equal(invalidRetry.status, 401);

const originalFetch = globalThis.fetch;
const fetched = [];
globalThis.fetch = async (url, init) => {
  fetched.push({ url, init });
  return Response.json({
    claude_code_session_id: "session-direct",
    claude_code_session_url: "https://claude.ai/code/session-direct"
  });
};

try {
  const result = await fireClaudeRoutine({
    token: "routine-token-test",
    triggerId: "trig/direct",
    text: "Human-readable Slack command context."
  });
  assert.equal(result.claude_code_session_url, "https://claude.ai/code/session-direct");
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(fetched.length, 1);
assert.equal(
  fetched[0].url,
  "https://api.anthropic.com/v1/claude_code/routines/trig%2Fdirect/fire"
);
assert.equal(fetched[0].init.method, "POST");
assert.equal(fetched[0].init.headers.Authorization, "Bearer routine-token-test");
assert.equal(fetched[0].init.headers["anthropic-beta"], "experimental-cc-routine-2026-04-01");
assert.equal(fetched[0].init.headers["anthropic-version"], "2023-06-01");
assert.equal(fetched[0].init.headers["Content-Type"], "application/json");
assert.deepEqual(JSON.parse(fetched[0].init.body), {
  text: "Human-readable Slack command context."
});

console.log("Slack event verifier passed.");
