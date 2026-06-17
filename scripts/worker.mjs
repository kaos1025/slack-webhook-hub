#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";

const DEFAULT_COMMAND_JOBS_TABLE = "command_jobs";
const DEFAULT_WORKER_QUEUE = "default";
const DEFAULT_WORKER_POLL_INTERVAL_MS = 5000;
const DEFAULT_WORKER_MAX_ITERATIONS = 0;
const DEFAULT_WORKER_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_WORKER_BACKEND = "placeholder";
const LOCAL_COMMAND_BACKEND = "local-command";
const PLAYWRIGHT_AGENT_BACKEND = "playwright-agent";
const GEMINI_REVIEWER_BACKEND = "gemini-reviewer";
const DEFAULT_AGENT_RUNS_ROOT = "/srv/agent-runs";
const DEFAULT_AGENT_TIMEOUT_MS = 300000;
const DEFAULT_AGENT_OUTPUT_MAX_CHARS = 12000;
const DEFAULT_GEMINI_REVIEW_MODEL = "gemini-2.5-pro";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_REVIEW_COMMAND = ["gemini", "-p", "{{prompt}}", "--approval-mode", "plan", "--output-format", "text", "--skip-trust"];
const DEFAULT_AGENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SSH_AUTH_SOCK"
];

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

function getAgentTimeoutMs(env) {
  const parsed = Number.parseInt(env.AGENT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_TIMEOUT_MS;
}

function getAgentOutputMaxChars(env) {
  const parsed = Number.parseInt(env.AGENT_OUTPUT_MAX_CHARS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_OUTPUT_MAX_CHARS;
}

function normalizeBackendName(rawBackend) {
  return typeof rawBackend === "string" && rawBackend.trim()
    ? rawBackend.trim().toLowerCase()
    : DEFAULT_WORKER_BACKEND;
}

function getRouteSnapshot(job) {
  return job?.route_snapshot && typeof job.route_snapshot === "object" ? job.route_snapshot : {};
}

function getJobCommandText(job) {
  return job.normalized_command ?? job.command_text ?? "";
}

function getAgentBackendName(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  return normalizeBackendName(routeSnapshot.agent?.backend ?? getWorkerBackend(env));
}

function parseAgentCommandConfig(rawCommandConfig, sourceLabel) {
  let parsed;
  if (Array.isArray(rawCommandConfig)) {
    parsed = rawCommandConfig;
  } else if (typeof rawCommandConfig === "string" && rawCommandConfig.trim()) {
    try {
      parsed = JSON.parse(rawCommandConfig);
    } catch (error) {
      throw new Error(`${sourceLabel} must be a JSON array: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  } else {
    parsed = null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${sourceLabel} must be a non-empty JSON array of strings`);
  }

  return parsed;
}

function getAgentCommandConfig(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  const routeCommandJson = routeSnapshot.agent?.commandJson;
  if (routeCommandJson !== undefined) {
    return parseAgentCommandConfig(routeCommandJson, "route_snapshot.agent.commandJson");
  }

  const commandJson = getEnvValue(env, "AGENT_COMMAND_JSON");
  if (!commandJson) {
    throw new Error("AGENT_COMMAND_JSON is required for local-command backend");
  }

  return parseAgentCommandConfig(commandJson, "AGENT_COMMAND_JSON");
}

function getPlaywrightAgentCommandConfig(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  const routeCommandJson = routeSnapshot.qa?.commandJson ?? routeSnapshot.agent?.commandJson;
  if (routeCommandJson !== undefined) {
    return parseAgentCommandConfig(routeCommandJson, "route_snapshot.qa.commandJson");
  }

  const commandJson = getEnvValue(env, "PLAYWRIGHT_AGENT_COMMAND_JSON");
  if (!commandJson) {
    throw new Error("PLAYWRIGHT_AGENT_COMMAND_JSON or route_snapshot.qa.commandJson is required for playwright-agent backend");
  }

  return parseAgentCommandConfig(commandJson, "PLAYWRIGHT_AGENT_COMMAND_JSON");
}

function safePathSegment(value, fallback = "job") {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

async function resolveQaArtifactDir(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  const artifactRoot = routeSnapshot.artifacts?.root ?? routeSnapshot.qa?.artifactRoot ?? getEnvValue(env, "AGENT_RUNS_ROOT", DEFAULT_AGENT_RUNS_ROOT);
  const candidate = path.resolve(artifactRoot, safePathSegment(job.id), "qa");
  await mkdir(candidate, { recursive: true });

  const resolvedRoot = await realpath(path.resolve(artifactRoot));
  const resolvedCandidate = await realpath(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`QA artifact path escapes artifact root: ${candidate}`);
  }

  return resolvedCandidate;
}

async function resolveReviewArtifactDir(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  const artifactRoot = routeSnapshot.artifacts?.root ?? routeSnapshot.review?.artifactRoot ?? getEnvValue(env, "AGENT_RUNS_ROOT", DEFAULT_AGENT_RUNS_ROOT);
  const candidate = path.resolve(artifactRoot, safePathSegment(job.id), "review");
  await mkdir(candidate, { recursive: true });

  const resolvedRoot = await realpath(path.resolve(artifactRoot));
  const resolvedCandidate = await realpath(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Review artifact path escapes artifact root: ${candidate}`);
  }

  return resolvedCandidate;
}

async function resolveImplementationArtifactDir(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  const artifactRoot = routeSnapshot.artifacts?.root ?? routeSnapshot.implementation?.artifactRoot ?? getEnvValue(env, "AGENT_RUNS_ROOT", DEFAULT_AGENT_RUNS_ROOT);
  const candidate = path.resolve(artifactRoot, safePathSegment(job.id), "implementation");
  await mkdir(candidate, { recursive: true });

  const resolvedRoot = await realpath(path.resolve(artifactRoot));
  const resolvedCandidate = await realpath(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Implementation artifact path escapes artifact root: ${candidate}`);
  }

  return resolvedCandidate;
}

async function resolveJobWorkspaceDir(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  const artifactRoot = routeSnapshot.artifacts?.root ?? routeSnapshot.implementation?.artifactRoot ?? getEnvValue(env, "AGENT_RUNS_ROOT", DEFAULT_AGENT_RUNS_ROOT);
  const candidate = path.resolve(artifactRoot, safePathSegment(job.id), "workspace");
  await mkdir(path.dirname(candidate), { recursive: true });

  const resolvedRoot = await realpath(path.resolve(artifactRoot));
  const relative = path.relative(resolvedRoot, path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Job workspace path escapes artifact root: ${candidate}`);
  }

  return path.resolve(candidate);
}

function buildQaProcessEnv(env, artifactDir, job) {
  return {
    ...buildAgentProcessEnv(env),
    PLAYWRIGHT_ARTIFACT_DIR: artifactDir,
    AGENT_RELAY_JOB_ID: job.id ?? "",
    AGENT_RELAY_PROJECT: job.project ?? ""
  };
}

async function writeQaSummaryArtifacts(artifactDir, payload) {
  const summaryJsonPath = path.join(artifactDir, "qa-summary.json");
  const summaryMdPath = path.join(artifactDir, "qa-summary.md");
  await writeFile(summaryJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(
    summaryMdPath,
    [
      `# Agent Relay QA Summary`,
      "",
      `- status: ${payload.status}`,
      `- backend: ${payload.backend}`,
      `- workspace: ${payload.workspace}`,
      `- artifactDir: ${payload.artifactDir}`,
      `- exitCode: ${payload.exitCode ?? "null"}`,
      `- signal: ${payload.signal ?? "null"}`,
      "",
      "## stdout",
      "",
      "```text",
      payload.stdout || "",
      "```",
      "",
      "## stderr",
      "",
      "```text",
      payload.stderr || "",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );
  return { summaryJsonPath, summaryMdPath };
}

function formatQaSummary(payload, artifactPaths) {
  return [
    `Playwright agent QA ${payload.status}.`,
    "",
    `Workspace: ${payload.workspace}`,
    `Artifact dir: ${payload.artifactDir}`,
    artifactPaths?.summaryMdPath ? `Summary: ${artifactPaths.summaryMdPath}` : null,
    "",
    payload.stdout ? `stdout:\n${payload.stdout}` : null,
    payload.stderr ? `stderr:\n${payload.stderr}` : null
  ].filter(Boolean).join("\n");
}

function formatReviewSummary(payload, artifactPaths) {
  return [
    `Gemini reviewer ${payload.status}.`,
    "",
    `Workspace: ${payload.workspace}`,
    `Artifact dir: ${payload.artifactDir}`,
    `Model: ${payload.model}`,
    artifactPaths?.reviewMdPath ? `Review: ${artifactPaths.reviewMdPath}` : null,
    "",
    payload.reviewText || ""
  ].filter(Boolean).join("\n");
}

function getGeminiApiKey(env) {
  return getEnvValue(env, "GEMINI_API_KEY") || getEnvValue(env, "GOOGLE_API_KEY");
}

function getGeminiReviewModel(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  return getEnvValue({ value: routeSnapshot.review?.model }, "value", getEnvValue(env, "GEMINI_REVIEW_MODEL", DEFAULT_GEMINI_REVIEW_MODEL));
}

function getGeminiReviewInvocation(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  return getEnvValue({ value: routeSnapshot.review?.invocation }, "value", getEnvValue(env, "GEMINI_REVIEW_INVOCATION", "cli")).toLowerCase();
}

function getGeminiReviewCommandConfig(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  return parseAgentCommandConfig(
    routeSnapshot.review?.commandJson ?? env.GEMINI_REVIEW_COMMAND_JSON ?? DEFAULT_GEMINI_REVIEW_COMMAND,
    routeSnapshot.review?.commandJson ? "route_snapshot.review.commandJson" : "GEMINI_REVIEW_COMMAND_JSON"
  );
}

function expandAgentTemplate(value, job, workspacePath, extraReplacements = {}) {
  const replacements = {
    "{{command}}": getJobCommandText(job),
    "{{project}}": job.project ?? "",
    "{{jobId}}": job.id ?? "",
    "{{workspace}}": workspacePath ?? "",
    ...extraReplacements
  };

  return Object.entries(replacements).reduce(
    (result, [token, replacement]) => result.split(token).join(replacement),
    value
  );
}

function truncateForSlack(text, maxChars = 2500) {
  if (typeof text !== "string") return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… truncated …` : text;
}

function truncateOutput(text, maxChars) {
  if (typeof text !== "string") return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… truncated …` : text;
}

function parseCsvEnv(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildAgentProcessEnv(baseEnv = process.env) {
  const allowlist = new Set([
    ...DEFAULT_AGENT_ENV_ALLOWLIST,
    ...parseCsvEnv(baseEnv.AGENT_ENV_ALLOWLIST)
  ]);
  const agentEnv = {};
  for (const name of allowlist) {
    const value = baseEnv[name] ?? process.env[name];
    if (typeof value === "string") {
      agentEnv[name] = value;
    }
  }
  return agentEnv;
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

async function resolveWorkspacePath(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  const configuredWorkspace = routeSnapshot.workspace?.path ?? getEnvValue(env, "AGENT_WORKDIR");
  if (!configuredWorkspace) {
    throw new Error("AGENT_WORKDIR or route_snapshot.workspace.path is required for local-command backend");
  }

  const workspaceRoot = getEnvValue(env, "AGENT_WORKSPACE_ROOT");
  const candidate = path.resolve(workspaceRoot || process.cwd(), configuredWorkspace);
  const resolvedWorkspace = await realpath(candidate);

  if (workspaceRoot) {
    const resolvedRoot = await realpath(path.resolve(workspaceRoot));
    const relative = path.relative(resolvedRoot, resolvedWorkspace);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Workspace path escapes AGENT_WORKSPACE_ROOT: ${configuredWorkspace}`);
    }
  }

  return resolvedWorkspace;
}

function isWorktreeIsolationEnabled(job) {
  return getRouteSnapshot(job).workspace?.isolation === "worktree";
}

function getImplementationBaseRef(job, env) {
  const routeSnapshot = getRouteSnapshot(job);
  return routeSnapshot.workspace?.baseRef ?? routeSnapshot.implementation?.baseRef ?? getEnvValue(env, "IMPLEMENTATION_BASE_REF", "origin/main");
}

function getImplementationBranchName(job) {
  const routeSnapshot = getRouteSnapshot(job);
  const prefix = routeSnapshot.workspace?.branchPrefix ?? routeSnapshot.implementation?.branchPrefix ?? `agent/${safePathSegment(job.project ?? "project")}`;
  const shortJobId = safePathSegment(String(job.id ?? "job").slice(0, 8));
  return `${String(prefix).replace(/\/+$/g, "")}/${shortJobId}`;
}

async function runGitCommand(workspacePath, args, env, label = "git") {
  return runProcess("git", args, {
    cwd: workspacePath,
    env: buildAgentProcessEnv(env),
    timeoutMs: getAgentTimeoutMs(env),
    outputMaxChars: getAgentOutputMaxChars(env)
  }).catch((error) => {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : "unknown git error"}`);
  });
}

async function setupImplementationWorkspace(job, env, baseWorkspacePath) {
  if (!isWorktreeIsolationEnabled(job)) {
    return {
      isolated: false,
      workspacePath: baseWorkspacePath,
      baseWorkspacePath,
      baseRef: null,
      branchName: null,
      workspaceArtifactPath: null
    };
  }

  const baseRef = getImplementationBaseRef(job, env);
  const branchName = getImplementationBranchName(job);
  const workspaceArtifactPath = await resolveJobWorkspaceDir(job, env);

  const routeSnapshot = getRouteSnapshot(job);
  if (routeSnapshot.workspace?.fetchBeforeWorktree === true) {
    await runGitCommand(baseWorkspacePath, ["fetch", "--prune", "origin"], env, "git fetch before worktree");
  }

  await runGitCommand(baseWorkspacePath, ["worktree", "add", "-b", branchName, workspaceArtifactPath, baseRef], env, "git worktree add");

  return {
    isolated: true,
    workspacePath: await realpath(workspaceArtifactPath),
    baseWorkspacePath,
    baseRef,
    branchName,
    workspaceArtifactPath
  };
}

function killProcessTree(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        console.warn(`Failed to send ${signal} to agent process group:`, error);
      }
      return false;
    }
  }

  return child.kill(signal);
}

function cleanupProcessTree(child) {
  if (process.platform === "win32") return;
  if (killProcessTree(child, "SIGTERM")) {
    killProcessTree(child, "SIGKILL");
  }
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const outputMaxChars = options.outputMaxChars ?? DEFAULT_AGENT_OUTPUT_MAX_CHARS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, 5000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = truncateOutput(stdout + chunk.toString(), outputMaxChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = truncateOutput(stderr + chunk.toString(), outputMaxChars);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      cleanupProcessTree(child);
      const result = { exitCode, signal, stdout, stderr, timedOut };
      if (timedOut) {
        reject(Object.assign(new Error(`Agent command timed out after ${timeoutMs}ms`), result));
        return;
      }
      if (exitCode !== 0) {
        reject(Object.assign(new Error(`Agent command failed with exit code ${exitCode}`), result));
        return;
      }
      resolve(result);
    });
  });
}

function formatJobTitle(job) {
  return `${job.project ?? "unknown project"} / ${job.id}`;
}

async function runGitCapture(workspacePath, args, env, fallbackLabel) {
  try {
    const result = await runProcess("git", args, {
      cwd: workspacePath,
      env: buildAgentProcessEnv(env),
      timeoutMs: Math.min(getAgentTimeoutMs(env), 60000),
      outputMaxChars: getAgentOutputMaxChars(env)
    });
    return result.stdout.trim() || result.stderr.trim() || `${fallbackLabel}: no output.`;
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    return [`${fallbackLabel}: unavailable.`, stdout, stderr, error instanceof Error ? error.message : "unknown git error"]
      .filter(Boolean)
      .join("\n");
  }
}

async function readOptionalText(filePath, label) {
  if (!filePath) return `${label}: not configured.`;
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    return `${label}: unavailable at ${filePath} (${error instanceof Error ? error.message : "read failed"}).`;
  }
}

async function finalizeImplementationWorkspace(job, env, context, commandConfig, agentResult) {
  if (!context.isolated) {
    return {
      context,
      artifactPaths: null,
      status: null,
      commitSha: null,
      diffPatch: ""
    };
  }

  const artifactDir = await resolveImplementationArtifactDir(job, env);
  const statusBeforeCommit = await runGitCapture(context.workspacePath, ["status", "--short"], env, "git status --short");
  const hasChanges = statusBeforeCommit.trim() && !statusBeforeCommit.includes("no output");
  let commitSha = null;

  if (hasChanges) {
    await runGitCommand(context.workspacePath, ["add", "-A"], env, "git add");
    const message = `agent: ${job.project ?? "project"} job ${safePathSegment(job.id ?? "job")}`;
    await runGitCommand(
      context.workspacePath,
      ["-c", "user.name=Agent Relay", "-c", "user.email=agent-relay@local", "commit", "-m", message],
      env,
      "git commit"
    );
    const revParse = await runGitCommand(context.workspacePath, ["rev-parse", "HEAD"], env, "git rev-parse HEAD");
    commitSha = revParse.stdout.trim();
  }

  const statusAfterCommit = await runGitCapture(context.workspacePath, ["status", "--short", "--branch"], env, "git status --short --branch");
  const diffPatch = context.baseRef
    ? await runGitCapture(context.workspacePath, ["diff", `${context.baseRef}...HEAD`], env, "git diff")
    : "git diff: baseRef not configured.";
  const diffStat = context.baseRef
    ? await runGitCapture(context.workspacePath, ["diff", "--stat", `${context.baseRef}...HEAD`], env, "git diff --stat")
    : "git diff --stat: baseRef not configured.";

  const payload = {
    status: "succeeded",
    backend: LOCAL_COMMAND_BACKEND,
    isolated: true,
    baseWorkspace: context.baseWorkspacePath,
    workspace: context.workspacePath,
    artifactDir,
    branchName: context.branchName,
    baseRef: context.baseRef,
    commitSha,
    hasChanges,
    command: commandConfig,
    commandText: getJobCommandText(job),
    exitCode: agentResult.exitCode,
    signal: agentResult.signal,
    stdout: agentResult.stdout.trim(),
    stderr: agentResult.stderr.trim(),
    statusBeforeCommit,
    statusAfterCommit,
    diffStat,
    diffPatch
  };

  const summaryJsonPath = path.join(artifactDir, "implementation-summary.json");
  const summaryMdPath = path.join(artifactDir, "implementation-summary.md");
  const diffPatchPath = path.join(artifactDir, "diff.patch");
  const statusPath = path.join(artifactDir, "status.txt");
  await writeFile(summaryJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(diffPatchPath, `${diffPatch}\n`, "utf8");
  await writeFile(statusPath, `${statusAfterCommit}\n`, "utf8");
  await writeFile(
    summaryMdPath,
    [
      "# Agent Relay Implementation Summary",
      "",
      `- status: ${payload.status}`,
      `- backend: ${payload.backend}`,
      `- isolated: ${payload.isolated}`,
      `- baseWorkspace: ${payload.baseWorkspace}`,
      `- workspace: ${payload.workspace}`,
      `- branchName: ${payload.branchName}`,
      `- baseRef: ${payload.baseRef}`,
      `- commitSha: ${payload.commitSha ?? "null"}`,
      `- hasChanges: ${payload.hasChanges}`,
      "",
      "## diff stat",
      "",
      "```text",
      payload.diffStat || "",
      "```",
      "",
      "## stdout",
      "",
      "```text",
      payload.stdout || "",
      "```",
      "",
      "## stderr",
      "",
      "```text",
      payload.stderr || "",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    context,
    artifactPaths: { summaryJsonPath, summaryMdPath, diffPatchPath, statusPath },
    status: payload,
    commitSha,
    diffPatch
  };
}

function formatImplementationSummary(agentSummary, finalization) {
  if (!finalization?.context?.isolated) {
    return agentSummary;
  }

  return [
    "Agent command completed in isolated worktree.",
    "",
    `Workspace: ${finalization.context.workspacePath}`,
    `Base workspace: ${finalization.context.baseWorkspacePath}`,
    `Branch: ${finalization.context.branchName}`,
    `Base ref: ${finalization.context.baseRef}`,
    `Local commit: ${finalization.commitSha ?? "none"}`,
    finalization.artifactPaths?.summaryMdPath ? `Implementation summary: ${finalization.artifactPaths.summaryMdPath}` : null,
    finalization.artifactPaths?.diffPatchPath ? `Diff patch: ${finalization.artifactPaths.diffPatchPath}` : null,
    "",
    agentSummary
  ].filter(Boolean).join("\n");
}

async function buildGeminiReviewPrompt(job, env, workspacePath, artifactDir) {
  const routeSnapshot = getRouteSnapshot(job);
  const baseRef = routeSnapshot.review?.baseRef ?? getEnvValue(env, "REVIEW_BASE_REF", "main");
  const diffStat = await runGitCapture(workspacePath, ["diff", "--stat", `${baseRef}...HEAD`], env, "git diff --stat");
  const diffPatch = await runGitCapture(workspacePath, ["diff", `${baseRef}...HEAD`], env, "git diff");
  const qaSummary = await readOptionalText(routeSnapshot.review?.qaSummaryPath, "QA summary");
  const implementationSummary = await readOptionalText(routeSnapshot.review?.implementationSummaryPath, "Implementation summary");
  const extraInstructions = routeSnapshot.review?.instructions ?? "";

  const prompt = [
    "# Agent Relay Gemini Review Task",
    "",
    "You are an independent, read-only code reviewer for an automated remote development pipeline.",
    "Do not suggest running destructive commands. Do not ask for secrets. Treat missing context as a risk, not as permission to assume success.",
    "",
    "Return the review in Markdown with these sections:",
    "- Verdict: approve | request_changes | blocked",
    "- Blockers",
    "- Security / secret-handling risks",
    "- Test coverage and QA gaps",
    "- Scope drift",
    "- Non-blocking suggestions",
    "- Evidence reviewed",
    "",
    "## Job",
    `- job_id: ${job.id ?? ""}`,
    `- project: ${job.project ?? ""}`,
    `- workspace: ${workspacePath}`,
    `- base_ref: ${baseRef}`,
    "",
    "## User / PM command",
    "```text",
    getJobCommandText(job),
    "```",
    "",
    extraInstructions ? ["## Additional review instructions", extraInstructions, ""].join("\n") : null,
    "## Implementation summary",
    "```text",
    implementationSummary,
    "```",
    "",
    "## QA summary",
    "```text",
    qaSummary,
    "```",
    "",
    "## Diff stat",
    "```text",
    diffStat,
    "```",
    "",
    "## Diff patch",
    "```diff",
    diffPatch,
    "```",
    ""
  ].filter(Boolean).join("\n");

  const promptPath = path.join(artifactDir, "review-prompt.md");
  await writeFile(promptPath, prompt, "utf8");
  return { prompt, promptPath, baseRef };
}

async function callGeminiReviewerApi(env, model, prompt, apiKey) {
  const response = await fetch(`${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    }),
    signal: createFetchSignal(env)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini reviewer request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }

  const payload = await response.json();
  const reviewText = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!reviewText) {
    throw new Error("Gemini reviewer returned no review text");
  }

  return { reviewText, rawPayload: payload, invocation: "api" };
}

async function callGeminiReviewerCli(job, env, workspacePath, prompt) {
  const commandConfig = getGeminiReviewCommandConfig(job, env);
  const [command, ...rawArgs] = commandConfig;
  const args = rawArgs.map((arg) => expandAgentTemplate(arg, job, workspacePath, {
    "{{prompt}}": prompt
  }));

  const result = await runProcess(command, args, {
    cwd: workspacePath,
    env: buildAgentProcessEnv(env),
    timeoutMs: getAgentTimeoutMs(env),
    outputMaxChars: getAgentOutputMaxChars(env)
  });

  const reviewText = result.stdout.trim();
  if (!reviewText) {
    throw new Error(`Gemini CLI reviewer returned no review text${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 500)}` : ""}`);
  }

  return {
    reviewText,
    rawPayload: {
      invocation: "cli",
      command: commandConfig,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr.trim()
    },
    invocation: "cli"
  };
}

async function callGeminiReviewer(job, env, model, prompt, workspacePath) {
  const invocation = getGeminiReviewInvocation(job, env);
  if (invocation === "cli") {
    return callGeminiReviewerCli(job, env, workspacePath, prompt);
  }
  if (invocation === "api") {
    const apiKey = getGeminiApiKey(env);
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required when GEMINI_REVIEW_INVOCATION=api");
    }
    return callGeminiReviewerApi(env, model, prompt, apiKey);
  }
  throw new Error(`Unsupported Gemini reviewer invocation: ${invocation}. Supported values: cli, api.`);
}

async function writeReviewArtifacts(artifactDir, payload) {
  const reviewJsonPath = path.join(artifactDir, "gemini-review.json");
  const reviewMdPath = path.join(artifactDir, "gemini-review.md");
  await writeFile(reviewJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(reviewMdPath, `${payload.reviewText}\n`, "utf8");
  return { reviewJsonPath, reviewMdPath, promptPath: payload.promptPath };
}

function buildWorkerStartedReply(job, workerId, backendName = job.worker_backend ?? DEFAULT_WORKER_BACKEND) {
  return [
    `Worker started command job for ${job.project}.`,
    "",
    `Command job ID: ${job.id}.`,
    `Worker ID: ${workerId}.`,
    `Queue: ${job.queue}.`,
    `Backend: ${backendName}.`
  ].join("\n");
}

function buildWorkerSucceededReply(job, result) {
  return [
    `Worker completed command job for ${job.project}.`,
    "",
    `Command job ID: ${job.id}.`,
    `Backend: ${result.backend}.`,
    result.workspace ? `Workspace: ${result.workspace}.` : null,
    "",
    truncateForSlack(result.summary)
  ].filter(Boolean).join("\n");
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

export async function runPlaceholderAgent(job) {
  return {
    backend: DEFAULT_WORKER_BACKEND,
    summary: [
      "Placeholder backend executed successfully.",
      "No repository changes were made in this phase.",
      "Next phase can replace this with Hermes/OpenClaw/Claude Code execution."
    ].join("\n"),
    metadata: {
      commandText: getJobCommandText(job),
      routeSnapshot: getRouteSnapshot(job)
    }
  };
}

export async function runLocalCommandAgent(job, env = process.env) {
  const baseWorkspacePath = await resolveWorkspacePath(job, env);
  const workspaceContext = await setupImplementationWorkspace(job, env, baseWorkspacePath);
  const workspacePath = workspaceContext.workspacePath;
  const commandConfig = getAgentCommandConfig(job, env);
  const [command, ...rawArgs] = commandConfig;
  const args = rawArgs.map((arg) => expandAgentTemplate(arg, job, workspacePath));
  const result = await runProcess(command, args, {
    cwd: workspacePath,
    env: buildAgentProcessEnv(env),
    timeoutMs: getAgentTimeoutMs(env),
    outputMaxChars: getAgentOutputMaxChars(env)
  });

  const outputSections = [];
  if (result.stdout.trim()) outputSections.push(result.stdout.trim());
  if (result.stderr.trim()) outputSections.push(`stderr:\n${result.stderr.trim()}`);
  const agentSummary = outputSections.length > 0
    ? outputSections.join("\n\n")
    : "Agent command completed successfully with no output.";
  const implementation = await finalizeImplementationWorkspace(job, env, workspaceContext, commandConfig, result);

  return {
    backend: LOCAL_COMMAND_BACKEND,
    workspace: workspacePath,
    summary: formatImplementationSummary(agentSummary, implementation),
    metadata: {
      command: commandConfig,
      exitCode: result.exitCode,
      signal: result.signal,
      commandText: getJobCommandText(job),
      implementation: implementation.status,
      artifacts: implementation.artifactPaths,
      workspaceIsolation: {
        isolated: workspaceContext.isolated,
        baseWorkspace: workspaceContext.baseWorkspacePath,
        workspace: workspaceContext.workspacePath,
        branchName: workspaceContext.branchName,
        baseRef: workspaceContext.baseRef
      }
    }
  };
}

export async function runPlaywrightAgent(job, env = process.env) {
  const workspacePath = await resolveWorkspacePath(job, env);
  const artifactDir = await resolveQaArtifactDir(job, env);
  const commandConfig = getPlaywrightAgentCommandConfig(job, env);
  const [command, ...rawArgs] = commandConfig;
  const args = rawArgs.map((arg) => expandAgentTemplate(arg, job, workspacePath, {
    "{{artifactDir}}": artifactDir
  }));

  try {
    const result = await runProcess(command, args, {
      cwd: workspacePath,
      env: buildQaProcessEnv(env, artifactDir, job),
      timeoutMs: getAgentTimeoutMs(env),
      outputMaxChars: getAgentOutputMaxChars(env)
    });

    const payload = {
      status: "succeeded",
      backend: PLAYWRIGHT_AGENT_BACKEND,
      workspace: workspacePath,
      artifactDir,
      command: commandConfig,
      commandText: getJobCommandText(job),
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    };
    const artifactPaths = await writeQaSummaryArtifacts(artifactDir, payload);

    return {
      backend: PLAYWRIGHT_AGENT_BACKEND,
      workspace: workspacePath,
      summary: formatQaSummary(payload, artifactPaths),
      metadata: {
        ...payload,
        artifacts: artifactPaths
      }
    };
  } catch (error) {
    const payload = {
      status: "failed",
      backend: PLAYWRIGHT_AGENT_BACKEND,
      workspace: workspacePath,
      artifactDir,
      command: commandConfig,
      commandText: getJobCommandText(job),
      exitCode: error?.exitCode ?? null,
      signal: error?.signal ?? null,
      stdout: typeof error?.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error?.stderr === "string" ? error.stderr.trim() : "",
      error: error instanceof Error ? error.message : "unknown playwright-agent error"
    };
    const artifactPaths = await writeQaSummaryArtifacts(artifactDir, payload);
    const enrichedError = new Error(`${payload.error}. QA artifacts: ${artifactPaths.summaryMdPath}`);
    enrichedError.cause = error;
    throw enrichedError;
  }
}

export async function runGeminiReviewer(job, env = process.env) {
  const workspacePath = await resolveWorkspacePath(job, env);
  const artifactDir = await resolveReviewArtifactDir(job, env);
  const model = getGeminiReviewModel(job, env);
  const { prompt, promptPath, baseRef } = await buildGeminiReviewPrompt(job, env, workspacePath, artifactDir);

  try {
    const { reviewText, rawPayload, invocation } = await callGeminiReviewer(job, env, model, prompt, workspacePath);
    const payload = {
      status: "succeeded",
      backend: GEMINI_REVIEWER_BACKEND,
      workspace: workspacePath,
      artifactDir,
      model,
      invocation,
      baseRef,
      commandText: getJobCommandText(job),
      promptPath,
      reviewText,
      responseMetadata: {
        invocation,
        command: rawPayload?.command ?? null,
        stderr: rawPayload?.stderr ?? null,
        finishReason: rawPayload?.candidates?.[0]?.finishReason ?? null,
        usageMetadata: rawPayload?.usageMetadata ?? null
      }
    };
    const artifactPaths = await writeReviewArtifacts(artifactDir, payload);

    return {
      backend: GEMINI_REVIEWER_BACKEND,
      workspace: workspacePath,
      summary: formatReviewSummary(payload, artifactPaths),
      metadata: {
        ...payload,
        artifacts: artifactPaths
      }
    };
  } catch (error) {
    const payload = {
      status: "failed",
      backend: GEMINI_REVIEWER_BACKEND,
      workspace: workspacePath,
      artifactDir,
      model,
      baseRef,
      commandText: getJobCommandText(job),
      promptPath,
      reviewText: "",
      error: error instanceof Error ? error.message : "unknown gemini-reviewer error"
    };
    const artifactPaths = await writeReviewArtifacts(artifactDir, payload);
    const enrichedError = new Error(`${payload.error}. Review artifacts: ${artifactPaths.reviewJsonPath}`);
    enrichedError.cause = error;
    throw enrichedError;
  }
}

export async function runAgentBackend(job, env = process.env) {
  const backend = getAgentBackendName(job, env);
  if (backend === DEFAULT_WORKER_BACKEND) {
    return runPlaceholderAgent(job, env);
  }
  if (backend === LOCAL_COMMAND_BACKEND) {
    return runLocalCommandAgent(job, env);
  }
  if (backend === PLAYWRIGHT_AGENT_BACKEND) {
    return runPlaywrightAgent(job, env);
  }
  if (backend === GEMINI_REVIEWER_BACKEND) {
    return runGeminiReviewer(job, env);
  }

  throw new Error(`Unsupported worker backend: ${backend}. Supported backends: ${DEFAULT_WORKER_BACKEND}, ${LOCAL_COMMAND_BACKEND}, ${PLAYWRIGHT_AGENT_BACKEND}, ${GEMINI_REVIEWER_BACKEND}.`);
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
  const backendName = getAgentBackendName(job, env);
  const runAgent = options.runAgent ?? runAgentBackend;
  const postMessage = options.postMessage ?? postSlackMessage;
  const updateJob = options.updateJob ?? updateClaimedCommandJob;

  console.log(`Processing command job ${formatJobTitle(job)}.`);

  await safePostWorkerMessage(
    env,
    postMessage,
    {
      channel: job.channel_id,
      threadTs: job.thread_ts ?? job.message_ts,
      text: buildWorkerStartedReply(job, workerId, backendName)
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
      last_error: null,
      result_summary: result.summary ?? null,
      result_metadata: result.metadata ?? {}
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
