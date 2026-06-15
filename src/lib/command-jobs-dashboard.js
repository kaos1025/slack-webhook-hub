const DEFAULT_COMMAND_JOBS_TABLE = "command_jobs";
const DEFAULT_DASHBOARD_LIMIT = 25;
const MAX_DASHBOARD_LIMIT = 100;

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Cache-Control", "no-store, private");
  return Response.json(body, { ...init, headers });
}

function getEnvValue(env, name, fallback = "") {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getHeader(headers, name) {
  if (typeof headers.get === "function") {
    return headers.get(name);
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function getSupabaseBaseUrl(env) {
  return getEnvValue(env, "COMMAND_JOBS_SUPABASE_URL").replace(/\/$/, "");
}

function getCommandJobsTableName(env) {
  return getEnvValue(env, "COMMAND_JOBS_TABLE", DEFAULT_COMMAND_JOBS_TABLE);
}

function parseLimit(rawLimit) {
  const parsed = Number.parseInt(rawLimit ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DASHBOARD_LIMIT;
  return Math.min(parsed, MAX_DASHBOARD_LIMIT);
}

function createFetchSignal(env) {
  const parsed = Number.parseInt(env.COMMAND_JOBS_FETCH_TIMEOUT_MS || "2500", 10);
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 2500;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}

function validateDashboardAuth(headers, env) {
  const dashboardToken = getEnvValue(env, "DASHBOARD_AUTH_TOKEN");
  if (!dashboardToken) {
    return { ok: false, status: 503, error: "dashboard_auth_not_configured" };
  }

  const authorization = getHeader(headers, "authorization") || "";
  if (authorization !== `Bearer ${dashboardToken}`) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  return { ok: true };
}

function buildDashboardQueryUrl(env, requestUrl) {
  const supabaseBaseUrl = getSupabaseBaseUrl(env);
  const serviceRoleKey = getEnvValue(env, "COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseBaseUrl || !serviceRoleKey) {
    throw new Error("Command job dashboard is not configured. Set COMMAND_JOBS_SUPABASE_URL and COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY.");
  }

  const url = new URL(requestUrl);
  const search = new URLSearchParams();
  search.set("select", "id,status,project,executor,queue,channel_id,user_id,event_id,message_ts,thread_ts,normalized_command,attempt_count,claimed_by,started_at,finished_at,last_error,created_at,updated_at");
  search.set("order", "created_at.desc");
  search.set("limit", String(parseLimit(url.searchParams.get("limit"))));

  for (const filter of ["status", "queue", "project"]) {
    const value = url.searchParams.get(filter);
    if (value) search.set(filter, `eq.${value}`);
  }

  const tableName = getCommandJobsTableName(env);
  return `${supabaseBaseUrl}/rest/v1/${encodeURIComponent(tableName)}?${search.toString()}`;
}

export async function handleCommandJobsDashboardRequest({ requestUrl, headers, env = process.env, fetchImpl = fetch }) {
  const auth = validateDashboardAuth(headers, env);
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error }, { status: auth.status });
  }

  let queryUrl;
  try {
    queryUrl = buildDashboardQueryUrl(env, requestUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "dashboard configuration error";
    return jsonResponse({ ok: false, error: "dashboard_configuration_error", message }, { status: 503 });
  }

  const serviceRoleKey = getEnvValue(env, "COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY");
  let response;
  try {
    response = await fetchImpl(queryUrl, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json"
      },
      signal: createFetchSignal(env)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "dashboard fetch failed";
    return jsonResponse(
      {
        ok: false,
        error: "command_jobs_query_failed",
        message
      },
      { status: 502 }
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return jsonResponse(
      {
        ok: false,
        error: "command_jobs_query_failed",
        status: response.status,
        message: body || `Supabase returned HTTP ${response.status}`
      },
      { status: 502 }
    );
  }

  let jobs;
  try {
    jobs = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : "dashboard response JSON parse failed";
    return jsonResponse(
      {
        ok: false,
        error: "command_jobs_query_failed",
        message
      },
      { status: 502 }
    );
  }
  return jsonResponse({ ok: true, jobs: Array.isArray(jobs) ? jobs : [] });
}

export const commandJobsDashboardInternals = {
  buildDashboardQueryUrl,
  parseLimit,
  validateDashboardAuth
};
