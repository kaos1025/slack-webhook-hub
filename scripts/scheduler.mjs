#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { runWorkerOnce } from "./worker.mjs";

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function loadDotEnvFile(filePath = ".env.local") {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  let content;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const equalsIndex = line.indexOf("=");
    const key = line.slice(0, equalsIndex).trim();
    if (!key || key.startsWith("export ")) continue;
    parsed[key] = unquoteEnvValue(line.slice(equalsIndex + 1));
  }
  return parsed;
}

export function buildSchedulerEnv(baseEnv = process.env, fileEnv = {}, overrides = {}) {
  return {
    ...fileEnv,
    ...baseEnv,
    WORKER_MAX_ITERATIONS: baseEnv.WORKER_MAX_ITERATIONS ?? fileEnv.WORKER_MAX_ITERATIONS ?? "1",
    ...overrides
  };
}

export async function runScheduledWorker({ env = process.env, envFile = ".env.local", overrides = {} } = {}) {
  const fileEnv = await loadDotEnvFile(envFile);
  const schedulerEnv = buildSchedulerEnv(env, fileEnv, overrides);
  return runWorkerOnce(schedulerEnv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const envFileArg = process.argv.find((arg) => arg.startsWith("--scheduler-env-file="));
  const envFile = envFileArg ? envFileArg.slice("--scheduler-env-file=".length) : ".env.local";
  runScheduledWorker({ envFile }).catch((error) => {
    console.error("Scheduled worker run failed:", error);
    process.exitCode = 1;
  });
}
