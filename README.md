# Slack Webhook Hub

Minimal Slack webhook hub with channel-based routing and a swappable execution backend.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set `SLACK_SIGNING_SECRET` from the Slack app's Basic Information page.
3. Set `SLACK_BOT_TOKEN` to the bot token used for `chat.postMessage`.
4. Optionally set `SLACK_BOT_USER_ID` to enable `@bot` mention commands.
5. Configure either legacy single-project routing or multi-project routing.
6. Run `npm install`, then `npm run dev`.

Configure Slack Event Subscriptions to send requests to:

```text
https://<your-host>/api/slack/events
```

The endpoint verifies Slack signatures, handles `url_verification`, quickly acknowledges `event_callback` when safe, ignores Slack retry deliveries for `routine`/`noop` routes to avoid duplicate routine fires, routes `클로드,` prefix commands or configured `@bot` mention commands by Slack channel ID, and dispatches them to the configured executor. `worker` routes first create or find a durable `command_jobs` record before acknowledging Slack so retries are idempotent. Replies are posted back to the source Slack thread.

## Legacy single-project routing

For one routed channel, use the original env variables:

```env
SLACK_EXECUTOR=noop
SLACK_ROUTINE_CHANNEL_ID=C0123456789
SLACK_ROUTINE_PROJECT=jullyssy-mall
SLACK_ROUTINE_TRIGGER_ID=trig_your_routine_trigger_id
ROUTINE_TOKEN=your-routine-token
```

`SLACK_EXECUTOR` supports:

- `routine` — fires the configured Claude routine. This is the default when `SLACK_EXECUTOR` is unset.
- `noop` — does not call Claude routine. It replies in the Slack thread that the command was accepted but no executor is active.
- `worker` — creates an idempotent `command_jobs` record before Slack ack and then posts a queued thread reply. Requires the worker persistence env vars below.

`SLACK_ROUTINE_PROJECT` is optional and only affects the human-readable project name included in Slack replies and routine context.

## Command triggers

The hub accepts commands in routed channels when the message text starts with either:

- `클로드,`
- a bot mention followed by command text, such as `<@U0123456789> do this`

Mention commands require `SLACK_BOT_USER_ID` to be set to the bot user ID, not the Slack App ID. Slack renders this as `@your-bot-name`, but event payload text uses the raw `<@U...>` mention form. Keep Slack Event Subscriptions on `message.channels`; do not also subscribe to `app_mention` for this flow because Slack can deliver the same bot mention through both event types and duplicate routine fires without durable idempotency.

## Multi-project routing

For multiple channels/projects, set `SLACK_ROUTES_JSON`. When this variable is present, it replaces legacy single-project routing.

```env
SLACK_ROUTES_JSON='[
  {
    "channelId": "C_JULLYSSY",
    "project": "jullyssy-mall",
    "executor": "routine",
    "triggerId": "trig_jullyssy",
    "tokenEnv": "ROUTINE_TOKEN_JULLYSSY",
    "allowedUserIds": ["U_ALLOWED_USER"]
  },
  {
    "channelId": "C_HUB",
    "project": "slack-webhook-hub",
    "executor": "noop"
  },
  {
    "channelId": "C_WORKER",
    "project": "worker-project",
    "executor": "worker",
    "workerQueue": "default",
    "allowedUserIds": ["U_ALLOWED_USER"]
  }
]'
ROUTINE_TOKEN_JULLYSSY=your-jullyssy-routine-token
```

Route fields:

- `channelId` — Slack channel ID to accept commands from.
- `project` — human-readable project name included in routine context and Slack replies.
- `executor` — `routine`, `noop`, or `worker`; omitted defaults to `routine`. Long-running agent execution remains outside the request lifecycle and is designed in [`docs/worker-agent-executor-design.md`](docs/worker-agent-executor-design.md).
- `triggerId` — Claude routine trigger ID, required for `routine` routes.
- `tokenEnv` — env var name containing that route's routine token; omitted defaults to `ROUTINE_TOKEN`.
- `workerQueue` — logical queue name for `worker` routes; omitted defaults to `default`.
- `allowedUserIds` — optional Slack user ID allowlist for this route. Omit it or set an empty array to allow any user in the routed channel. When set, commands from other users are rejected in the Slack thread and no executor is run. If present, it must be an array of non-empty strings; malformed values invalidate the route instead of failing open.

Keep routine tokens in separate env vars; do not place secret tokens inside `SLACK_ROUTES_JSON`.

## Worker executor persistence

`worker` routes enqueue commands into a Supabase/PostgREST `command_jobs` table before Slack is acknowledged. Apply [`docs/command-jobs-schema.sql`](docs/command-jobs-schema.sql), then configure:

```env
COMMAND_JOBS_SUPABASE_URL=https://your-project.supabase.co
COMMAND_JOBS_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
COMMAND_JOBS_TABLE=command_jobs
COMMAND_JOBS_FETCH_TIMEOUT_MS=2500
SLACK_WORKER_QUEUE=default

# Worker process only
WORKER_ID=worker-local-1
WORKER_BACKEND=placeholder
WORKER_POLL_INTERVAL_MS=5000
WORKER_MAX_ITERATIONS=0
WORKER_FETCH_TIMEOUT_MS=10000
```

The service-role key is a secret and must only be stored in runtime env vars. It is never embedded in `SLACK_ROUTES_JSON`.

If persistence is unavailable, the webhook returns HTTP 503 instead of Slack 200 so Slack can retry rather than silently dropping the command. New jobs are inserted without merge-updating existing rows; on unique-key conflict, the adapter looks up the existing job and treats the delivery as a duplicate. A successful enqueue posts a queued status reply with the command job ID; duplicate worker retries avoid duplicate queued replies.

Run the worker skeleton separately from the Vercel webhook:

```bash
npm run worker
```

The worker calls the `claim_command_job` Postgres function, transitions one queued job at a time to `running`, posts a Slack thread "started" reply, executes the current `placeholder` backend, then conditionally marks its own `running` claim `succeeded` or `failed` and posts a final Slack thread reply. Slack reply failures are logged but do not flip the job result. `WORKER_MAX_ITERATIONS=1` is useful for one-shot local smoke tests; `0` means run continuously.

## Worker / agent executor design

The next execution path is documented in [`docs/worker-agent-executor-design.md`](docs/worker-agent-executor-design.md). The recommended sequence is:

1. keep `routine` as the production executor,
2. use the `worker` enqueue-only executor and durable command job persistence,
3. run the separate worker skeleton to claim jobs and post placeholder status updates,
4. plug Hermes/OpenClaw/Claude Code agent backends into that worker.

This avoids running long repo-aware agent sessions inside the Slack/Vercel request lifecycle.

## Slack retry handling

Slack may redeliver the same event with `X-Slack-Retry-Num` and `X-Slack-Retry-Reason` when it thinks a previous delivery failed or timed out. For `routine` and `noop` routes, the hub verifies the Slack signature first, then returns `{ ok: true, ignored: "slack_retry" }` without running an executor or posting a Slack thread reply. For `worker` routes, the signed retry still goes through the pre-ack idempotent job insert/lookup so durable persistence, not the retry header alone, controls duplicate handling.

## Verification

Run the local behavior verifiers:

```bash
npm run verify:slack
npm run verify:worker
```

`verify:slack` checks signed challenge handling, signed event ack behavior, Slack retry suppression, legacy routine compatibility, noop executor replies, worker enqueue behavior, worker retry idempotency behavior, worker persistence failure handling, unsupported executor handling, `클로드,` prefix commands, bot mention commands, bot mention edge cases, multi-route routine dispatch, route-level user allowlist rejection, multi-route noop dispatch, unrouted-channel skip behavior, missing config skip behavior, Slack thread replies, stale request rejection, and invalid signature rejection.

`verify:worker` checks the worker claim RPC call shape, idle behavior, status updates, started/succeeded/failed Slack thread replies, placeholder backend execution, and unsupported backend failure handling.
