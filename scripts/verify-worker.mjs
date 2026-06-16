#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claimNextCommandJob,
  processCommandJob,
  runAgentBackend,
  runLocalCommandAgent,
  runPlaywrightAgent,
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await wait(100);
  }
  return false;
}

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
assert.match(successUpdates[0].patch.result_summary, /Placeholder backend executed successfully/);
assert.equal(successUpdates[0].patch.result_metadata.commandText, "클로드, README 업데이트해줘");
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

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-relay-worker-"));
const tempWorkspace = path.join(tempRoot, "repo");
await mkdtemp(`${tempWorkspace}-`)
  .then(async (created) => {
    const localCommandJob = {
      ...sampleJob,
      route_snapshot: {
        ...sampleJob.route_snapshot,
        agent: { backend: "local-command" },
        workspace: { path: path.basename(created) }
      }
    };
    const localResult = await runLocalCommandAgent(localCommandJob, {
      ...baseEnv,
      SLACK_SIGNING_SECRET: "signing-secret-test",
      ROUTINE_TOKEN: "routine-token-test",
      AGENT_WORKSPACE_ROOT: tempRoot,
      AGENT_COMMAND_JSON: JSON.stringify([
        process.execPath,
        "-e",
        "console.log('agent:' + process.argv[1]); console.error('cwd:' + process.cwd()); console.log('leaked:' + Boolean(process.env.SLACK_BOT_TOKEN || process.env.COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY || process.env.SLACK_SIGNING_SECRET || process.env.ROUTINE_TOKEN))",
        "{{command}}"
      ])
    });
    assert.equal(localResult.backend, "local-command");
    assert.equal(localResult.workspace, created);
    assert.match(localResult.summary, /agent:클로드, README 업데이트해줘/);
    assert.match(localResult.summary, /leaked:false/);
    assert.match(localResult.summary, /stderr:\ncwd:/);

    const routedResult = await runAgentBackend(localCommandJob, {
      ...baseEnv,
      WORKER_BACKEND: "placeholder",
      AGENT_WORKSPACE_ROOT: tempRoot,
      AGENT_COMMAND_JSON: JSON.stringify([process.execPath, "-e", "console.log('routed')"])
    });
    assert.equal(routedResult.backend, "local-command");

    const routeCommandOverrideJob = {
      ...localCommandJob,
      route_snapshot: {
        ...localCommandJob.route_snapshot,
        agent: {
          backend: "local-command",
          commandJson: [
            process.execPath,
            "-e",
            "console.log('route-command:' + process.argv[1])",
            "{{project}}/{{jobId}}"
          ]
        }
      }
    };
    const routeCommandOverrideResult = await runLocalCommandAgent(routeCommandOverrideJob, {
      ...baseEnv,
      AGENT_WORKSPACE_ROOT: tempRoot,
      AGENT_COMMAND_JSON: JSON.stringify([
        process.execPath,
        "-e",
        "console.log('env-command-should-not-run')"
      ])
    });
    assert.match(routeCommandOverrideResult.summary, /route-command:agent-relay\/job-1/);
    assert.doesNotMatch(routeCommandOverrideResult.summary, /env-command-should-not-run/);
    assert.deepEqual(routeCommandOverrideResult.metadata.command, routeCommandOverrideJob.route_snapshot.agent.commandJson);

    const invalidRouteCommandError = await runLocalCommandAgent(
      {
        ...routeCommandOverrideJob,
        route_snapshot: {
          ...routeCommandOverrideJob.route_snapshot,
          agent: { backend: "local-command", commandJson: [process.execPath, 42] }
        }
      },
      {
        ...baseEnv,
        AGENT_WORKSPACE_ROOT: tempRoot,
        AGENT_COMMAND_JSON: JSON.stringify([process.execPath, "-e", "console.log('unused')"])
      }
    ).then(
      () => null,
      (error) => error
    );
    assert.match(invalidRouteCommandError.message, /route_snapshot\.agent\.commandJson must be a non-empty JSON array of strings/);

    const playwrightQaJob = {
      ...localCommandJob,
      id: "qa/job:1",
      route_snapshot: {
        ...localCommandJob.route_snapshot,
        agent: { backend: "playwright-agent" },
        qa: {
          commandJson: [
            process.execPath,
            "-e",
            [
              "const fs = require('node:fs');",
              "console.log('qa-command:' + process.argv[1]);",
              "console.log('artifact-env:' + process.env.PLAYWRIGHT_ARTIFACT_DIR);",
              "fs.writeFileSync(process.env.PLAYWRIGHT_ARTIFACT_DIR + '/agent-output.txt', 'ok');"
            ].join(" "),
            "{{artifactDir}}"
          ]
        },
        artifacts: { root: path.join(tempRoot, "runs") }
      }
    };
    const playwrightResult = await runPlaywrightAgent(playwrightQaJob, {
      ...baseEnv,
      AGENT_WORKSPACE_ROOT: tempRoot
    });
    assert.equal(playwrightResult.backend, "playwright-agent");
    assert.match(playwrightResult.summary, /Playwright agent QA succeeded/);
    assert.match(playwrightResult.summary, /qa-command:/);
    assert.match(playwrightResult.metadata.artifactDir, /qa-job-1\/qa$/);
    assert.equal(await readFile(path.join(playwrightResult.metadata.artifactDir, "agent-output.txt"), "utf8"), "ok");
    const qaSummaryJson = JSON.parse(await readFile(playwrightResult.metadata.artifacts.summaryJsonPath, "utf8"));
    assert.equal(qaSummaryJson.status, "succeeded");
    assert.equal(qaSummaryJson.backend, "playwright-agent");
    assert.match(await readFile(playwrightResult.metadata.artifacts.summaryMdPath, "utf8"), /Agent Relay QA Summary/);

    const routedQaResult = await runAgentBackend(playwrightQaJob, {
      ...baseEnv,
      WORKER_BACKEND: "placeholder",
      AGENT_WORKSPACE_ROOT: tempRoot
    });
    assert.equal(routedQaResult.backend, "playwright-agent");

    const failedQaError = await runPlaywrightAgent(
      {
        ...playwrightQaJob,
        id: "qa-fail",
        route_snapshot: {
          ...playwrightQaJob.route_snapshot,
          qa: {
            commandJson: [process.execPath, "-e", "console.error('qa-failed'); process.exit(7)"]
          }
        }
      },
      {
        ...baseEnv,
        AGENT_WORKSPACE_ROOT: tempRoot
      }
    ).then(
      () => null,
      (error) => error
    );
    assert.match(failedQaError.message, /Agent command failed with exit code 7/);
    assert.match(failedQaError.message, /QA artifacts:/);

    const nestedRoot = await mkdtemp(path.join(tempRoot, "nested-root-"));
    const escapedResult = await runLocalCommandAgent(
      {
        ...sampleJob,
        route_snapshot: {
          ...sampleJob.route_snapshot,
          workspace: { path: created }
        }
      },
      {
        ...baseEnv,
        WORKER_BACKEND: "local-command",
        AGENT_WORKSPACE_ROOT: nestedRoot,
        AGENT_COMMAND_JSON: JSON.stringify([process.execPath, "-e", "console.log('should not run')"])
      }
    ).then(
      () => null,
      (error) => error
    );
    assert.match(escapedResult.message, /escapes AGENT_WORKSPACE_ROOT/);

    if (process.platform !== "win32") {
      const orphanPidFile = path.join(tempRoot, "orphan-pid.txt");
      const orphanResult = await runLocalCommandAgent(localCommandJob, {
        ...baseEnv,
        AGENT_WORKSPACE_ROOT: tempRoot,
        AGENT_COMMAND_JSON: JSON.stringify([
          process.execPath,
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
            `fs.writeFileSync(${JSON.stringify(orphanPidFile)}, String(child.pid));`,
            "child.unref();",
            "console.log('spawned:' + child.pid);"
          ].join(" ")
        ])
      });
      assert.match(orphanResult.summary, /spawned:/);
      const orphanPid = Number.parseInt(await readFile(orphanPidFile, "utf8"), 10);
      assert.equal(await waitForProcessExit(orphanPid), true);
    }
  })
  .finally(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

const unsupportedBackend = await runAgentBackend(sampleJob, {
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
