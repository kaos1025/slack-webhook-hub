#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  claimNextCommandJob,
  processCommandJob,
  runPlaceholderAgent,
  runWorkerOnce,
  updateClaimedCommandJob,
  updateCommandJob
} from "./worker.mjs";

const baseEnv = {
  COMMAND_JOBS_SUPABASE_URL: "https://example.supabase.co/",
  COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  COMMAND_JOBS_TABLE: "command_jobs",
  SLACK_WORKER_QUEUE: "critical",
  WORKER_ID: "worker-test-1",
  WORKER_FETCH_TIMEOUT_MS: "2500",
  WORKER_BACKEND: "placeholder",
  SLACK_BOT_TOKEN: "xoxb-test"
};

const sampleJob = {
  id: "job-1",
  project: "agent-relay",
  executor: "worker",
  queue: "critical",
  channel_id: "C_WORKER",
  thread_ts: "1710000000.000100",
  message_ts: "1710000000.000100",
  command_text: "클로드, README 업데이트해줘",
  normalized_command: "클로드, README 업데이트해줘",
  route_snapshot: { project: "agent-relay", executor: "worker" },
  attempt_count: 1
};

const originalFetch = globalThis.fetch;

const claimCalls = [];
globalThis.fetch = async (url, init) => {
  claimCalls.push({ url, init });
  return Response.json([{ ...sampleJob, status: "running", claimed_by: "worker-test-1" }]);
};
try {
  const job = await claimNextCommandJob(baseEnv);
  assert.equal(job.id, "job-1");
  assert.equal(claimCalls.length, 1);
  assert.equal(claimCalls[0].url, "https://example.supabase.co/rest/v1/rpc/claim_command_job");
  assert.equal(claimCalls[0].init.method, "POST");
  assert.equal(claimCalls[0].init.headers.apikey, "service-role-test");
  assert.deepEqual(JSON.parse(claimCalls[0].init.body), {
    requested_queue: "critical",
    worker_id: "worker-test-1"
  });
} finally {
  globalThis.fetch = originalFetch;
}

const idleClaimCalls = [];
globalThis.fetch = async (url, init) => {
  idleClaimCalls.push({ url, init });
  return Response.json([]);
};
try {
  const job = await claimNextCommandJob(baseEnv);
  assert.equal(job, null);
  assert.equal(idleClaimCalls.length, 1);
} finally {
  globalThis.fetch = originalFetch;
}

const updateCalls = [];
globalThis.fetch = async (url, init) => {
  updateCalls.push({ url, init });
  return Response.json([{ id: "job-1", status: "succeeded" }]);
};
try {
  const job = await updateCommandJob(baseEnv, "job-1", { status: "succeeded" });
  assert.equal(job.id, "job-1");
  assert.equal(
    updateCalls[0].url,
    "https://example.supabase.co/rest/v1/command_jobs?id=eq.job-1"
  );
  assert.equal(updateCalls[0].init.method, "PATCH");
  assert.equal(updateCalls[0].init.headers.Prefer, "return=representation");
  assert.deepEqual(JSON.parse(updateCalls[0].init.body), { status: "succeeded" });
} finally {
  globalThis.fetch = originalFetch;
}

const claimedUpdateCalls = [];
globalThis.fetch = async (url, init) => {
  claimedUpdateCalls.push({ url, init });
  return Response.json([{ id: "job-1", status: "succeeded", claimed_by: "worker-test-1" }]);
};
try {
  const job = await updateClaimedCommandJob(baseEnv, "job-1", "worker-test-1", { status: "succeeded" });
  assert.equal(job.id, "job-1");
  assert.equal(
    claimedUpdateCalls[0].url,
    "https://example.supabase.co/rest/v1/command_jobs?id=eq.job-1&status=eq.running&claimed_by=eq.worker-test-1"
  );
  assert.equal(claimedUpdateCalls[0].init.method, "PATCH");
} finally {
  globalThis.fetch = originalFetch;
}

const successUpdates = [];
const successMessages = [];
const successResult = await processCommandJob(baseEnv, sampleJob, {
  updateJob: async (_env, jobId, workerId, patch) => {
    successUpdates.push({ jobId, workerId, patch });
    return { ...sampleJob, ...patch };
  },
  postMessage: async (_env, message) => {
    successMessages.push(message);
  }
});
assert.equal(successResult.status, "succeeded");
assert.equal(successUpdates.length, 1);
assert.equal(successUpdates[0].jobId, "job-1");
assert.equal(successUpdates[0].workerId, "worker-test-1");
assert.equal(successUpdates[0].patch.status, "succeeded");
assert.equal(successUpdates[0].patch.last_error, null);
assert.equal(successMessages.length, 2);
assert.match(successMessages[0].text, /Worker started command job/);
assert.match(successMessages[1].text, /Placeholder backend executed successfully/);
assert.equal(successMessages[0].channel, "C_WORKER");
assert.equal(successMessages[0].threadTs, "1710000000.000100");

const failedUpdates = [];
const failedMessages = [];
const failedResult = await processCommandJob(baseEnv, sampleJob, {
  runAgent: async () => {
    throw new Error("placeholder failure");
  },
  updateJob: async (_env, jobId, workerId, patch) => {
    failedUpdates.push({ jobId, workerId, patch });
    return { ...sampleJob, ...patch };
  },
  postMessage: async (_env, message) => {
    failedMessages.push(message);
  }
});
assert.equal(failedResult.status, "failed");
assert.equal(failedUpdates.length, 1);
assert.equal(failedUpdates[0].patch.status, "failed");
assert.equal(failedUpdates[0].patch.last_error, "placeholder failure");
assert.equal(failedMessages.length, 2);
assert.match(failedMessages[1].text, /Worker failed command job/);
assert.match(failedMessages[1].text, /placeholder failure/);

const slackFailureUpdates = [];
const slackFailureResult = await processCommandJob(baseEnv, sampleJob, {
  updateJob: async (_env, jobId, workerId, patch) => {
    slackFailureUpdates.push({ jobId, workerId, patch });
    return { ...sampleJob, ...patch };
  },
  postMessage: async () => {
    throw new Error("slack unavailable");
  }
});
assert.equal(slackFailureResult.status, "succeeded");
assert.equal(slackFailureUpdates.length, 1);
assert.equal(slackFailureUpdates[0].patch.status, "succeeded");

const updateFailureMessages = [];
const updateFailureResult = await processCommandJob(baseEnv, sampleJob, {
  updateJob: async () => {
    throw new Error("claimed row not found");
  },
  postMessage: async (_env, message) => {
    updateFailureMessages.push(message);
  }
});
assert.equal(updateFailureResult.status, "update_failed");
assert.equal(updateFailureMessages.length, 1);
assert.match(updateFailureMessages[0].text, /Worker started command job/);

const failedUpdateFailureMessages = [];
const failedUpdateFailureResult = await processCommandJob(baseEnv, sampleJob, {
  runAgent: async () => {
    throw new Error("agent failed before update");
  },
  updateJob: async () => {
    throw new Error("failed status update unavailable");
  },
  postMessage: async (_env, message) => {
    failedUpdateFailureMessages.push(message);
  }
});
assert.equal(failedUpdateFailureResult.status, "update_failed");
assert.equal(failedUpdateFailureMessages.length, 1);
assert.match(failedUpdateFailureMessages[0].text, /Worker started command job/);

const unsupportedBackend = await runPlaceholderAgent(sampleJob, {
  ...baseEnv,
  WORKER_BACKEND: "claude-code"
}).then(
  () => null,
  (error) => error
);
assert.match(unsupportedBackend.message, /Unsupported worker backend/);

const idleResult = await runWorkerOnce(baseEnv, {
  claimJob: async () => null,
  processJob: async () => {
    throw new Error("idle path should not process job");
  }
});
assert.deepEqual(idleResult, { status: "idle" });

const processed = [];
const onceResult = await runWorkerOnce(baseEnv, {
  claimJob: async () => sampleJob,
  processJob: async (_env, job) => {
    processed.push(job.id);
    return { status: "succeeded", job };
  }
});
assert.equal(onceResult.status, "succeeded");
assert.deepEqual(processed, ["job-1"]);

console.log("Worker verifier passed.");
