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
  const commandJobCalls = [];
  const response = await handleSlackEventsRequest({
    rawBody,
    headers: options.headers ?? signedHeaders(rawBody),
    env: {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_EXECUTOR: "routine",
      SLACK_BOT_USER_ID: "U_BOT",
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
    enqueueJob: async (payloadForJob, envForJob, routeForJob) => {
      commandJobCalls.push({ payload: payloadForJob, env: envForJob, route: routeForJob });
      if (options.enqueueJob) {
        return options.enqueueJob(payloadForJob, envForJob, routeForJob);
      }

      return {
        id: "job-test",
        idempotencyKey: `${payloadForJob.team_id ?? "unknown-team"}:event:${payloadForJob.event_id}`,
        isDuplicate: false
      };
    },
    nowSeconds
  });

  await waitImmediate();
  return { response, routineCalls, slackCalls, commandJobCalls };
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

const mentionCommand = await call({
  type: "event_callback",
  event_id: "EvMentionCommand",
  team_id: "T1",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "<@U_BOT> hello via mention",
    ts: "1710000000.000105"
  }
});
assert.equal(mentionCommand.response.status, 200);
assert.equal(mentionCommand.routineCalls.length, 1);
assert.match(mentionCommand.routineCalls[0].text, /Command text: <@U_BOT> hello via mention/);
assert.match(mentionCommand.routineCalls[0].text, /Slack event type: message/);
assert.equal(mentionCommand.slackCalls.length, 2);
assert.equal(
  mentionCommand.slackCalls[1].text,
  "Routine fired for single routed project: https://claude.ai/code/session-test"
);

const mentionCommaCommand = await call({
  type: "event_callback",
  event_id: "EvMentionCommaCommand",
  team_id: "T1",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "<@U_BOT>, hello via comma mention",
    ts: "1710000000.000106"
  }
});
assert.equal(mentionCommaCommand.response.status, 200);
assert.equal(mentionCommaCommand.routineCalls.length, 1);
assert.equal(mentionCommaCommand.slackCalls.length, 2);

const mentionColonCommand = await call({
  type: "event_callback",
  event_id: "EvMentionColonCommand",
  team_id: "T1",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "<@U_BOT>: hello via colon mention",
    ts: "1710000000.000106"
  }
});
assert.equal(mentionColonCommand.response.status, 200);
assert.equal(mentionColonCommand.routineCalls.length, 1);
assert.equal(mentionColonCommand.slackCalls.length, 2);

const mentionWithoutBody = await call({
  type: "event_callback",
  event_id: "EvMentionWithoutBody",
  team_id: "T1",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "<@U_BOT>",
    ts: "1710000000.000106"
  }
});
assert.equal(mentionWithoutBody.response.status, 200);
assert.equal(mentionWithoutBody.routineCalls.length, 0);
assert.equal(mentionWithoutBody.slackCalls.length, 0);

const mentionWithoutSeparator = await call({
  type: "event_callback",
  event_id: "EvMentionWithoutSeparator",
  team_id: "T1",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "<@U_BOT>hello without separator",
    ts: "1710000000.000106"
  }
});
assert.equal(mentionWithoutSeparator.response.status, 200);
assert.equal(mentionWithoutSeparator.routineCalls.length, 0);
assert.equal(mentionWithoutSeparator.slackCalls.length, 0);

const mentionWrongBot = await call({
  type: "event_callback",
  event_id: "EvMentionWrongBot",
  team_id: "T1",
  event: {
    type: "message",
    channel: routineChannel,
    user: "U1",
    text: "<@U_OTHER> hello wrong bot",
    ts: "1710000000.000106"
  }
});
assert.equal(mentionWrongBot.response.status, 200);
assert.equal(mentionWrongBot.routineCalls.length, 0);
assert.equal(mentionWrongBot.slackCalls.length, 0);

const appMentionIgnored = await call({
  type: "event_callback",
  event_id: "EvAppMentionIgnored",
  team_id: "T1",
  event: {
    type: "app_mention",
    channel: routineChannel,
    user: "U1",
    text: "<@U_BOT> app mention event is ignored to avoid duplicate fires",
    ts: "1710000000.000106"
  }
});
assert.equal(appMentionIgnored.response.status, 200);
assert.equal(appMentionIgnored.routineCalls.length, 0);
assert.equal(appMentionIgnored.slackCalls.length, 0);

const mentionWithoutConfiguredBotId = await call(
  {
    type: "event_callback",
    event_id: "EvMentionWithoutConfiguredBotId",
    team_id: "T1",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "<@U_BOT> ignored without configured bot ID",
      ts: "1710000000.000107"
    }
  },
  {
    env: {
      SLACK_BOT_USER_ID: ""
    }
  }
);
assert.equal(mentionWithoutConfiguredBotId.response.status, 200);
assert.equal(mentionWithoutConfiguredBotId.routineCalls.length, 0);
assert.equal(mentionWithoutConfiguredBotId.slackCalls.length, 0);

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
    project: "alpha-petcut",
    executor: "worker",
    workerQueue: "petcut",
    commandPrefix: "petcut",
    allowedUserIds: ["U1"],
    workspace: { path: "PetCut", isolation: "worktree", baseRef: "origin/main" },
    agent: { backend: "local-command" },
    artifacts: { root: "/srv/agent-runs" },
    implementation: { artifactRoot: "/srv/agent-runs" },
    qa: { commandJson: ["npx", "playwright", "test"] },
    review: { baseRef: "origin/main" }
  },
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
    channelId: "C_WORKER",
    project: "worker-project",
    executor: "worker",
    workerQueue: "critical",
    allowedUserIds: ["U_WORKER"],
    workspace: {
      type: "git",
      repo: "git@github.com:kaos1025/worker-project.git",
      branch: "main"
    },
    agent: {
      backend: "placeholder"
    },
    policy: {
      allowCommit: true,
      allowFeatureBranchPush: true,
      allowBaseBranchPush: false,
      allowPrCreate: true
    }
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
assert.match(multiRoutine.slackCalls[1].text, /Routine fired for alpha: https:\/\/claude.ai\/code\/session-test/);

const sameChannelPrefixedWorker = await call(
  {
    type: "event_callback",
    event_id: "EvSameChannelPrefixedWorker",
    team_id: "T_PREFIX",
    event: {
      type: "message",
      channel: "C_ALPHA",
      user: "U1",
      text: "클로드, petcut add smoke test",
      ts: "1710000000.000525"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: "",
      ROUTINE_TOKEN_ALPHA: "routine-token-alpha"
    },
    enqueueJob: async (payloadForJob, envForJob, routeForJob) => {
      assert.equal(routeForJob.project, "alpha-petcut");
      assert.equal(routeForJob.executor, "worker");
      assert.equal(routeForJob.workerQueue, "petcut");
      assert.equal(routeForJob.commandPrefix, "petcut");
      assert.equal(routeForJob.workspace.path, "PetCut");
      assert.equal(routeForJob.workspace.isolation, "worktree");
      assert.equal(routeForJob.artifacts.root, "/srv/agent-runs");
      assert.equal(routeForJob.implementation.artifactRoot, "/srv/agent-runs");
      assert.deepEqual(routeForJob.qa.commandJson, ["npx", "playwright", "test"]);
      assert.equal(routeForJob.review.baseRef, "origin/main");
      assert.equal(envForJob.SLACK_ROUTES_JSON, routesJson);
      return {
        id: "job-prefix-petcut",
        idempotencyKey: "T_PREFIX:event:EvSameChannelPrefixedWorker",
        isDuplicate: false
      };
    }
  }
);
assert.equal(sameChannelPrefixedWorker.response.status, 200);
assert.equal(sameChannelPrefixedWorker.commandJobCalls.length, 1);
assert.equal(sameChannelPrefixedWorker.routineCalls.length, 0);
assert.equal(sameChannelPrefixedWorker.slackCalls.length, 1);
assert.match(sameChannelPrefixedWorker.slackCalls[0].text, /Command queued by slack-webhook-hub for alpha-petcut/);
assert.match(sameChannelPrefixedWorker.slackCalls[0].text, /Worker queue: petcut/);

const emptyRoutesLegacyFallback = await call(
  {
    type: "event_callback",
    event_id: "EvEmptyRoutesLegacyFallback",
    event: {
      type: "message",
      channel: routineChannel,
      user: "U1",
      text: "클로드, legacy fallback",
      ts: "1710000000.000530"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: "[]"
    }
  }
);
assert.equal(emptyRoutesLegacyFallback.response.status, 200);
assert.equal(emptyRoutesLegacyFallback.routineCalls.length, 1);
assert.match(emptyRoutesLegacyFallback.routineCalls[0].text, /Route project: single routed project/);

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

const workerQueued = await call(
  {
    type: "event_callback",
    event_id: "EvWorkerQueued",
    team_id: "T_WORKER",
    enterprise_id: "E_WORKER",
    event: {
      type: "message",
      channel: "C_WORKER",
      user: "U_WORKER",
      text: "클로드, enqueue worker job",
      ts: "1710000000.000670"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: ""
    },
    enqueueJob: async (payloadForJob, envForJob, routeForJob) => {
      assert.equal(routeForJob.executor, "worker");
      assert.equal(routeForJob.workerQueue, "critical");
      assert.equal(payloadForJob.event_id, "EvWorkerQueued");
      assert.equal(envForJob.SLACK_ROUTES_JSON, routesJson);
      return {
        id: "job-worker-1",
        idempotencyKey: "T_WORKER:event:EvWorkerQueued",
        isDuplicate: false
      };
    }
  }
);
assert.equal(workerQueued.response.status, 200);
assert.deepEqual(await workerQueued.response.json(), { ok: true });
assert.equal(workerQueued.commandJobCalls.length, 1);
assert.equal(workerQueued.routineCalls.length, 0);
assert.equal(workerQueued.slackCalls.length, 1);
assert.equal(workerQueued.slackCalls[0].threadTs, "1710000000.000670");
assert.match(workerQueued.slackCalls[0].text, /Command queued by slack-webhook-hub for worker-project/);
assert.match(workerQueued.slackCalls[0].text, /Configured executor: worker/);
assert.match(workerQueued.slackCalls[0].text, /Worker queue: critical/);
assert.match(workerQueued.slackCalls[0].text, /Command job ID: job-worker-1/);

const workerDuplicateRetryRawBody = JSON.stringify({
  type: "event_callback",
  event_id: "EvWorkerDuplicate",
  team_id: "T_WORKER",
  event: {
    type: "message",
    channel: "C_WORKER",
    user: "U_WORKER",
    text: "클로드, duplicate worker retry",
    ts: "1710000000.000671"
  }
});
const workerDuplicateRetryHeaders = signedHeaders(workerDuplicateRetryRawBody);
workerDuplicateRetryHeaders.set("x-slack-retry-num", "1");
workerDuplicateRetryHeaders.set("x-slack-retry-reason", "http_timeout");
const workerDuplicateRetry = await call(JSON.parse(workerDuplicateRetryRawBody), {
  headers: workerDuplicateRetryHeaders,
  env: {
    SLACK_ROUTES_JSON: routesJson,
    SLACK_ROUTINE_CHANNEL_ID: ""
  },
  enqueueJob: async () => ({
    id: "job-worker-duplicate",
    idempotencyKey: "T_WORKER:event:EvWorkerDuplicate",
    isDuplicate: true
  })
});
assert.equal(workerDuplicateRetry.response.status, 200);
assert.deepEqual(await workerDuplicateRetry.response.json(), { ok: true });
assert.equal(workerDuplicateRetry.commandJobCalls.length, 1);
assert.equal(workerDuplicateRetry.routineCalls.length, 0);
assert.equal(workerDuplicateRetry.slackCalls.length, 0);

const workerPersistenceUnavailable = await call(
  {
    type: "event_callback",
    event_id: "EvWorkerPersistenceUnavailable",
    team_id: "T_WORKER",
    event: {
      type: "message",
      channel: "C_WORKER",
      user: "U_WORKER",
      text: "클로드, persistence is down",
      ts: "1710000000.000672"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: ""
    },
    enqueueJob: async () => {
      throw new Error("test persistence down");
    }
  }
);
assert.equal(workerPersistenceUnavailable.response.status, 503);
assert.deepEqual(await workerPersistenceUnavailable.response.json(), {
  error: "worker_persistence_unavailable",
  message: "test persistence down"
});
assert.equal(workerPersistenceUnavailable.commandJobCalls.length, 1);
assert.equal(workerPersistenceUnavailable.routineCalls.length, 0);
assert.equal(workerPersistenceUnavailable.slackCalls.length, 0);

const workerUnauthorized = await call(
  {
    type: "event_callback",
    event_id: "EvWorkerUnauthorized",
    team_id: "T_WORKER",
    event: {
      type: "message",
      channel: "C_WORKER",
      user: "U_DENIED",
      text: "클로드, denied worker job",
      ts: "1710000000.000673"
    }
  },
  {
    env: {
      SLACK_ROUTES_JSON: routesJson,
      SLACK_ROUTINE_CHANNEL_ID: ""
    }
  }
);
assert.equal(workerUnauthorized.response.status, 200);
assert.equal(workerUnauthorized.commandJobCalls.length, 0);
assert.equal(workerUnauthorized.routineCalls.length, 0);
assert.equal(workerUnauthorized.slackCalls.length, 1);
assert.match(workerUnauthorized.slackCalls[0].text, /not allowed for worker-project/);

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
const supabaseFetched = [];
const workerDefaultRawBody = JSON.stringify({
  type: "event_callback",
  event_id: "EvWorkerDefaultAdapter",
  team_id: "T_WORKER",
  event: {
    type: "message",
    channel: "C_WORKER",
    user: "U_WORKER",
    text: "클로드, default adapter worker job",
    ts: "1710000000.000674"
  }
});
globalThis.fetch = async (url, init) => {
  supabaseFetched.push({ url, init });
  return Response.json([
    {
      id: "job-default-adapter",
      idempotency_key: "T_WORKER:event:EvWorkerDefaultAdapter"
    }
  ]);
};
try {
  const workerDefaultAdapterSlackCalls = [];
  const workerDefaultAdapter = await handleSlackEventsRequest({
    rawBody: workerDefaultRawBody,
    headers: signedHeaders(workerDefaultRawBody),
    env: {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_ROUTES_JSON: routesJson,
      COMMAND_JOBS_SUPABASE_URL: "https://example.supabase.co/",
      COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      COMMAND_JOBS_TABLE: "command_jobs"
    },
    fireRoutine: async () => {
      throw new Error("worker default adapter should not fire routine");
    },
    postMessage: async (message) => {
      workerDefaultAdapterSlackCalls.push(message);
    },
    nowSeconds
  });
  await waitImmediate();
  assert.equal(workerDefaultAdapter.status, 200);
  assert.deepEqual(await workerDefaultAdapter.json(), { ok: true });
  assert.equal(supabaseFetched.length, 1);
  assert.equal(
    supabaseFetched[0].url,
    "https://example.supabase.co/rest/v1/command_jobs"
  );
  assert.equal(supabaseFetched[0].init.method, "POST");
  assert.equal(supabaseFetched[0].init.headers.apikey, "service-role-test");
  assert.equal(supabaseFetched[0].init.headers.Authorization, "Bearer service-role-test");
  assert.equal(supabaseFetched[0].init.headers.Prefer, "return=representation");
  const commandJobBody = JSON.parse(supabaseFetched[0].init.body);
  assert.equal(commandJobBody.idempotency_key, "T_WORKER:event:EvWorkerDefaultAdapter");
  assert.equal(commandJobBody.status, "queued");
  assert.equal(commandJobBody.project, "worker-project");
  assert.equal(commandJobBody.executor, "worker");
  assert.equal(commandJobBody.queue, "critical");
  assert.equal(commandJobBody.channel_id, "C_WORKER");
  assert.equal(commandJobBody.user_id, "U_WORKER");
  assert.equal(commandJobBody.thread_ts, "1710000000.000674");
  assert.equal(commandJobBody.route_snapshot.project, "worker-project");
  assert.equal(workerDefaultAdapterSlackCalls.length, 1);
  assert.match(workerDefaultAdapterSlackCalls[0].text, /Command job ID: job-default-adapter/);
} finally {
  globalThis.fetch = originalFetch;
}

const supabaseDuplicateFetched = [];
const workerDuplicateAdapterRawBody = JSON.stringify({
  type: "event_callback",
  event_id: "EvWorkerDefaultDuplicate",
  team_id: "T_WORKER",
  event: {
    type: "message",
    channel: "C_WORKER",
    user: "U_WORKER",
    text: "클로드, default adapter duplicate job",
    ts: "1710000000.000675"
  }
});
globalThis.fetch = async (url, init) => {
  supabaseDuplicateFetched.push({ url, init });
  if (supabaseDuplicateFetched.length === 1) {
    return Response.json({ code: "23505" }, { status: 409 });
  }

  return Response.json([
    {
      id: "job-existing-adapter",
      idempotency_key: "T_WORKER:event:EvWorkerDefaultDuplicate",
      status: "running"
    }
  ]);
};
try {
  const workerDuplicateAdapterSlackCalls = [];
  const workerDuplicateAdapter = await handleSlackEventsRequest({
    rawBody: workerDuplicateAdapterRawBody,
    headers: signedHeaders(workerDuplicateAdapterRawBody),
    env: {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_ROUTES_JSON: routesJson,
      COMMAND_JOBS_SUPABASE_URL: "https://example.supabase.co/",
      COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      COMMAND_JOBS_TABLE: "command_jobs"
    },
    fireRoutine: async () => {
      throw new Error("duplicate worker default adapter should not fire routine");
    },
    postMessage: async (message) => {
      workerDuplicateAdapterSlackCalls.push(message);
    },
    nowSeconds
  });
  await waitImmediate();
  assert.equal(workerDuplicateAdapter.status, 200);
  assert.deepEqual(await workerDuplicateAdapter.json(), { ok: true });
  assert.equal(supabaseDuplicateFetched.length, 2);
  assert.equal(supabaseDuplicateFetched[0].url, "https://example.supabase.co/rest/v1/command_jobs");
  assert.equal(supabaseDuplicateFetched[0].init.method, "POST");
  assert.equal(
    supabaseDuplicateFetched[1].url,
    "https://example.supabase.co/rest/v1/command_jobs?idempotency_key=eq.T_WORKER%3Aevent%3AEvWorkerDefaultDuplicate&select=id,idempotency_key,status"
  );
  assert.equal(supabaseDuplicateFetched[1].init.method, "GET");
  assert.equal(workerDuplicateAdapterSlackCalls.length, 0);
} finally {
  globalThis.fetch = originalFetch;
}

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
