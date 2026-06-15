#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commandJobsDashboardInternals,
  handleCommandJobsDashboardRequest
} from "../src/lib/command-jobs-dashboard.js";
import { buildSchedulerEnv, loadDotEnvFile, runScheduledWorker } from "./scheduler.mjs";

const dashboardEnv = {
  COMMAND_JOBS_SUPABASE_URL: "https://example.supabase.co/",
  COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  COMMAND_JOBS_TABLE: "command_jobs",
  DASHBOARD_AUTH_TOKEN: "dashboard-token-test",
  COMMAND_JOBS_FETCH_TIMEOUT_MS: "2500"
};

const unauthorized = await handleCommandJobsDashboardRequest({
  requestUrl: "https://hub.test/api/command-jobs",
  headers: new Headers(),
  env: dashboardEnv,
  fetchImpl: async () => {
    throw new Error("fetch should not run for unauthorized dashboard requests");
  }
});
assert.equal(unauthorized.status, 401);
assert.deepEqual(await unauthorized.json(), { ok: false, error: "unauthorized" });

const unconfigured = await handleCommandJobsDashboardRequest({
  requestUrl: "https://hub.test/api/command-jobs",
  headers: new Headers({ authorization: "Bearer dashboard-token-test" }),
  env: { ...dashboardEnv, DASHBOARD_AUTH_TOKEN: "" },
  fetchImpl: async () => {
    throw new Error("fetch should not run for unconfigured dashboard auth");
  }
});
assert.equal(unconfigured.status, 503);
assert.deepEqual(await unconfigured.json(), { ok: false, error: "dashboard_auth_not_configured" });

const dashboardFetchCalls = [];
const ok = await handleCommandJobsDashboardRequest({
  requestUrl: "https://hub.test/api/command-jobs?status=queued&queue=default&project=KronosStock&limit=250",
  headers: new Headers({ authorization: "Bearer dashboard-token-test" }),
  env: dashboardEnv,
  fetchImpl: async (url, init) => {
    dashboardFetchCalls.push({ url, init });
    return Response.json([
      {
        id: "job-1",
        status: "queued",
        project: "KronosStock",
        queue: "default"
      }
    ]);
  }
});
assert.equal(ok.status, 200);
assert.equal(ok.headers.get("cache-control"), "no-store, private");
assert.deepEqual(await ok.json(), {
  ok: true,
  jobs: [{ id: "job-1", status: "queued", project: "KronosStock", queue: "default" }]
});
assert.equal(dashboardFetchCalls.length, 1);
assert.match(dashboardFetchCalls[0].url, /^https:\/\/example\.supabase\.co\/rest\/v1\/command_jobs\?/);
const queried = new URL(dashboardFetchCalls[0].url);
assert.equal(queried.searchParams.get("status"), "eq.queued");
assert.equal(queried.searchParams.get("queue"), "eq.default");
assert.equal(queried.searchParams.get("project"), "eq.KronosStock");
assert.equal(queried.searchParams.get("limit"), "100");
assert.equal(dashboardFetchCalls[0].init.headers.apikey, "service-role-test");
assert.equal(dashboardFetchCalls[0].init.headers.Authorization, "Bearer service-role-test");

const failed = await handleCommandJobsDashboardRequest({
  requestUrl: "https://hub.test/api/command-jobs",
  headers: new Headers({ authorization: "Bearer dashboard-token-test" }),
  env: dashboardEnv,
  fetchImpl: async () => new Response("upstream unavailable", { status: 503 })
});
assert.equal(failed.status, 502);
assert.match((await failed.json()).message, /upstream unavailable/);

const fetchRejected = await handleCommandJobsDashboardRequest({
  requestUrl: "https://hub.test/api/command-jobs",
  headers: new Headers({ authorization: "Bearer dashboard-token-test" }),
  env: dashboardEnv,
  fetchImpl: async () => {
    throw new Error("network down");
  }
});
assert.equal(fetchRejected.status, 502);
assert.equal(fetchRejected.headers.get("cache-control"), "no-store, private");
assert.match((await fetchRejected.json()).message, /network down/);

const invalidJson = await handleCommandJobsDashboardRequest({
  requestUrl: "https://hub.test/api/command-jobs",
  headers: new Headers({ authorization: "Bearer dashboard-token-test" }),
  env: dashboardEnv,
  fetchImpl: async () => new Response("not-json", { status: 200 })
});
assert.equal(invalidJson.status, 502);
assert.match((await invalidJson.json()).message, /JSON/);

assert.equal(commandJobsDashboardInternals.parseLimit("0"), 25);
assert.equal(commandJobsDashboardInternals.parseLimit("10"), 10);
assert.equal(commandJobsDashboardInternals.parseLimit("999"), 100);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-scheduler-"));
try {
  const envFile = path.join(tempDir, ".env.local");
  await writeFile(
    envFile,
    [
      "# comment",
      "COMMAND_JOBS_TABLE=command_jobs",
      "AGENT_COMMAND_JSON='[\"claude\",\"-p\",\"{{command}}\"]'",
      "WORKER_MAX_ITERATIONS=3"
    ].join("\n"),
    "utf8"
  );
  const fileEnv = await loadDotEnvFile(envFile);
  assert.equal(fileEnv.COMMAND_JOBS_TABLE, "command_jobs");
  assert.equal(fileEnv.AGENT_COMMAND_JSON, '["claude","-p","{{command}}"]');
  assert.equal(fileEnv.WORKER_MAX_ITERATIONS, "3");

  const defaultOneShotEnv = buildSchedulerEnv({}, { COMMAND_JOBS_TABLE: "command_jobs" });
  assert.equal(defaultOneShotEnv.WORKER_MAX_ITERATIONS, "1");

  const fileIterationEnv = buildSchedulerEnv({}, fileEnv);
  assert.equal(fileIterationEnv.WORKER_MAX_ITERATIONS, "3");

  const processEnvWins = buildSchedulerEnv({ COMMAND_JOBS_TABLE: "custom_jobs" }, fileEnv);
  assert.equal(processEnvWins.COMMAND_JOBS_TABLE, "custom_jobs");

  const overrideEnv = buildSchedulerEnv({ WORKER_MAX_ITERATIONS: "2" }, fileEnv, { WORKER_MAX_ITERATIONS: "5" });
  assert.equal(overrideEnv.WORKER_MAX_ITERATIONS, "5");

  await assert.rejects(
    runScheduledWorker({ env: {}, envFile: path.join(tempDir, "missing.env") }),
    /Missing worker env/
  );

  const cliFailure = spawnSync(
    process.execPath,
    ["scripts/scheduler.mjs", `--scheduler-env-file=${path.join(tempDir, "missing.env")}`],
    { cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH ?? "" } }
  );
  assert.notEqual(cliFailure.status, 0);
  assert.match(cliFailure.stderr, /Scheduled worker run failed/);
  assert.match(cliFailure.stderr, /Missing worker env/);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("Dashboard and scheduler verification passed.");
