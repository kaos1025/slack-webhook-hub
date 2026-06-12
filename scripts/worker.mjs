#!/usr/bin/env node

const DEFAULT_COMMAND_JOBS_TABLE = "command_jobs";
const DEFAULT_WORKER_QUEUE = "default";
const DEFAULT_WORKER_POLL_INTERVAL_MS = 5000;
const DEFAULT_WORKER_MAX_ITERATIONS = 0;
const DEFAULT_WORKER_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_WORKER_BACKEND = "placeholder";

function getEnvValue(env, name, fallback = "") {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getSupabaseBaseUrl(env) {
  return getEnvValue(env, "COMMAND_JOBS_SUPABASE_URL").replace(/\/$/, "");
}

function getCommandJobsTableName(env) {
  return getEnvValue(env, "COMMAND_JOBS_TABLE", DEFAULT_COMMAND_JOBS_TABLE);
}

function getWorkerQueue(env) {
  return getEnvValue(env, "SLACK_WORKER_QUEUE", DEFAULT_WORKER_QUEUE);
}

function getWorkerId(env) {
  return getEnvValue(env, "WORKER_ID", `worker-${process.pid}`);
}

function parsePositiveInteger(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getWorkerPollIntervalMs(env) {
  return parsePositiveInteger(env.WORKER_POLL_INTERVAL_MS, DEFAULT_WORKER_POLL_INTERVAL_MS);
}

function getWorkerMaxIterations(env) {
  return parsePositiveInteger(env.WORKER_MAX_ITERATIONS, DEFAULT_WORKER_MAX_ITERATIONS);
}

function getWorkerFetchTimeoutMs(env) {
  const parsed = Number.parseInt(env.WORKER_FETCH_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKER_FETCH_TIMEOUT_MS;
}

function getWorkerBackend(env) {
  return getEnvValue(env, "WORKER_BACKEND", DEFAULT_WORKER_BACKEND).toLowerCase();
}

function validateWorkerEnv(env) {
  const missing = [];
  if (!getSupabaseBaseUrl(env)) missing.push("COMMAND_JOBS_SUPABASE_URL");
  if (!getEnvValue(env, "COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY")) {
    missing.push("COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY");
  }

  if (missing.length > 0) {
    throw new Error(`Missing worker env: ${missing.join(", ")}`);
  }
}

function buildSupabaseHeaders(env, extraHeaders = {}) {
  const serviceRoleKey = getEnvValue(env, "COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extraHeaders
  };
}

function createFetchSignal(env) {
  const timeoutMs = getWorkerFetchTimeoutMs(env);
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}

async function fetchSupabase(env, path, init = {}) {
  validateWorkerEnv(env);
  const baseUrl = getSupabaseBaseUrl(env);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: createFetchSignal(env)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Supabase request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function buildCommandJobPatchPath(env, filters) {
  const tableName = getCommandJobsTableName(env);
  const query = Object.entries(filters)
    .map(([key, value]) => `${encodeURIComponent(key)}=eq.${encodeURIComponent(value)}`)
    .join("&");

  return `/rest/v1/${encodeURIComponent(tableName)}?${query}`;
}

export async function claimNextCommandJob(env = process.env) {
  const queue = getWorkerQueue(env);
  const workerId = getWorkerId(env);
  const result = await fetchSupabase(env, "/rest/v1/rpc/claim_command_job", {
    method: "POST",
    headers: buildSupabaseHeaders(env, {
      "Content-Type": "application/json",
      Accept: "application/json"
    }),
    body: JSON.stringify({
      requested_queue: queue,
      worker_id: workerId
    })
  });

  const job = Array.isArray(result) ? result[0] : result;
  return job?.id ? job : null;
}

async function patchCommandJob(env, filters, patch) {
  const result = await fetchSupabase(env, buildCommandJobPatchPath(env, filters), {
    method: "PATCH",
    headers: buildSupabaseHeaders(env, {
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify(patch)
  });

  const job = Array.isArray(result) ? result[0] : result;
  if (!job?.id) {
    throw new Error(`Command job update returned no row for filters ${JSON.stringify(filters)}`);
  }

  return job;
}

export async function updateCommandJob(env = process.env, jobId, patch) {
  if (!jobId) {
    throw new Error("jobId is required to update a command job");
  }

  return patchCommandJob(env, { id: jobId }, patch);
}

export async function updateClaimedCommandJob(env = process.env, jobId, workerId, patch) {
  if (!jobId) {
    throw new Error("jobId is required to update a claimed command job");
  }
  if (!workerId) {
    throw new Error("workerId is required to update a claimed command job");
  }

  return patchCommandJob(
    env,
    {
      id: jobId,
      status: "running",
      claimed_by: workerId
    },
    patch
  );
}

export async function postSlackMessage(env = process.env, { channel, threadTs, text }) {
  const token = getEnvValue(env, "SLACK_BOT_TOKEN");
  if (!token) {
    console.warn("Skipping Slack worker reply because SLACK_BOT_TOKEN is not configured.");
    return null;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs,
      text
    }),
    signal: createFetchSignal(env)
  });

  if (!response.ok) {
    throw new Error(`Slack Web API request failed with HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Slack Web API request failed: ${result.error ?? "unknown_error"}`);
  }

  return result;
}

function formatJobTitle(job) {
  return `${job.project ?? "unknown project"} / ${job.id}`;
}

function buildWorkerStartedReply(job, workerId) {
  return [
    `Worker started command job for ${job.project}.`,
    "",
    `Command job ID: ${job.id}.`,
    `Worker ID: ${workerId}.`,
    `Queue: ${job.queue}.`,
    `Backend: ${job.worker_backend ?? DEFAULT_WORKER_BACKEND}.`
  ].join("\n");
}

function buildWorkerSucceededReply(job, result) {
  return [
    `Worker completed command job for ${job.project}.`,
    "",
    `Command job ID: ${job.id}.`,
    `Backend: ${result.backend}.`,
    "",
    result.summary
  ].join("\n");
}

function buildWorkerFailedReply(job, error) {
  const errorMessage = error instanceof Error ? error.message : "unknown worker error";
  return [
    `Worker failed command job for ${job.project}.`,
    "",
    `Command job ID: ${job.id}.`,
    errorMessage
  ].join("\n");
}

export async function runPlaceholderAgent(job, env = process.env) {
  const backend = getWorkerBackend(env);
  if (backend !== DEFAULT_WORKER_BACKEND) {
    throw new Error(`Unsupported worker backend: ${backend}. Only ${DEFAULT_WORKER_BACKEND} is implemented in the skeleton.`);
  }

  return {
    backend,
    summary: [
      "Placeholder backend executed successfully.",
      "No repository changes were made in this phase.",
      "Next phase can replace this with Hermes/OpenClaw/Claude Code execution."
    ].join("\n"),
    metadata: {
      commandText: job.normalized_command ?? job.command_text ?? "",
      routeSnapshot: job.route_snapshot ?? {}
    }
  };
}

async function safePostWorkerMessage(env, postMessage, message, label) {
  try {
    await postMessage(env, message);
  } catch (error) {
    console.error(`Worker Slack ${label} reply failed:`, error);
  }
}

export async function processCommandJob(env = process.env, job, options = {}) {
  const workerId = getWorkerId(env);
  const runAgent = options.runAgent ?? runPlaceholderAgent;
  const postMessage = options.postMessage ?? postSlackMessage;
  const updateJob = options.updateJob ?? updateClaimedCommandJob;

  console.log(`Processing command job ${formatJobTitle(job)}.`);

  await safePostWorkerMessage(
    env,
    postMessage,
    {
      channel: job.channel_id,
      threadTs: job.thread_ts ?? job.message_ts,
      text: buildWorkerStartedReply(job, workerId)
    },
    "started"
  );

  let result;
  try {
    result = await runAgent(job, env);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown worker error";
    console.error(`Command job ${job.id} failed:`, error);
    try {
      await updateJob(env, job.id, workerId, {
        status: "failed",
        finished_at: new Date().toISOString(),
        last_error: errorMessage
      });
    } catch (updateError) {
      console.error(`Failed to mark command job ${job.id} as failed:`, updateError);
      return { status: "update_failed", job, error, updateError };
    }
    await safePostWorkerMessage(
      env,
      postMessage,
      {
        channel: job.channel_id,
        threadTs: job.thread_ts ?? job.message_ts,
        text: buildWorkerFailedReply(job, error)
      },
      "failed"
    );
    return { status: "failed", job, error };
  }

  try {
    await updateJob(env, job.id, workerId, {
      status: "succeeded",
      finished_at: new Date().toISOString(),
      last_error: null
    });
  } catch (error) {
    console.error(`Failed to mark command job ${job.id} as succeeded:`, error);
    return { status: "update_failed", job, result, error };
  }

  await safePostWorkerMessage(
    env,
    postMessage,
    {
      channel: job.channel_id,
      threadTs: job.thread_ts ?? job.message_ts,
      text: buildWorkerSucceededReply(job, result)
    },
    "succeeded"
  );
  return { status: "succeeded", job, result };
}

export async function runWorkerOnce(env = process.env, options = {}) {
  const claimJob = options.claimJob ?? claimNextCommandJob;
  const processJob = options.processJob ?? processCommandJob;
  const job = await claimJob(env);
  if (!job) {
    console.log(`No queued command job available for queue ${getWorkerQueue(env)}.`);
    return { status: "idle" };
  }

  return processJob(env, job, options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWorkerLoop(env = process.env, options = {}) {
  const maxIterations = getWorkerMaxIterations(env);
  const pollIntervalMs = getWorkerPollIntervalMs(env);
  let iterations = 0;

  while (maxIterations === 0 || iterations < maxIterations) {
    iterations += 1;
    try {
      const result = await runWorkerOnce(env, options);
      if (result.status === "idle") {
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      console.error("Worker loop iteration failed:", error);
      await sleep(pollIntervalMs);
    }
  }

  return { status: "stopped", iterations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkerLoop(process.env).catch((error) => {
    console.error("Worker exited with an unrecoverable error:", error);
    process.exitCode = 1;
  });
}
