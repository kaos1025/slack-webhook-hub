# Worker / Agent Executor Design

Status: proposed
Scope: Slack Webhook Hub executor evolution after `noop`, `routine`, route allowlists, and bot mention UX.

## 1. Goal

Move long-running or repo-aware work out of the Slack Events request path and into a worker/agent execution layer while preserving the existing stable webhook contract:

1. Slack request is verified and acknowledged quickly.
2. Routing, user allowlists, and command parsing stay in the hub.
3. Executors are swappable per route.
4. Slack operators get thread-visible status updates.
5. Long-running work can survive serverless time limits and retries.

## 2. Current baseline

The hub currently supports:

- `noop` executor: posts an accepted/no-op thread reply.
- `routine` executor: fires a Claude routine and posts the returned session URL.
- Route table env config via `SLACK_ROUTES_JSON`.
- Route-level `allowedUserIds`.
- `클로드,` and configured bot mention command triggers.
- Lightweight Slack retry suppression using `X-Slack-Retry-Num`.

The next step is not to replace `routine` immediately. Instead, add an executor abstraction that can target a durable job queue and later an agent worker.

## 3. Ack, enqueue, and idempotency rule

For `worker` routes, the hub must not acknowledge Slack before it has either:

1. completed an idempotent durable insert of the command job within Slack's 3 second window, or
2. handed the raw signed event to a platform-supported durable inbox/queue with equivalent delivery guarantees.

Recommended first implementation: parse and authorize the event, perform an idempotent `command_jobs` insert keyed by Slack event identity, then return 200. If the insert finds an existing job, return 200 and optionally post/skip a duplicate-safe status. If persistence is unavailable, return a non-2xx response so Slack can retry rather than silently dropping the command.

This is stricter than the current `routine` path, which uses post-response work for immediate remote dispatch. It is required before replacing lightweight retry suppression with durable exactly-once-ish handling.

## 4. Recommended target architecture

```text
Slack Events API
  │
  ▼
Next/Vercel Hub: /api/slack/events
  ├─ verify Slack signature
  ├─ url_verification support
  ├─ command parsing
  ├─ channel route lookup
  ├─ allowedUserIds check
  ├─ if executor=worker:
  │    └─ idempotent durable insert / durable inbox handoff before ack
  ├─ fast 200 ack
  └─ post-ack duplicate-safe work only:
       ├─ noop status reply
       ├─ routine dispatch/status reply
       └─ worker queued/status reply, using the pre-ack job ID
             │
             ▼
       durable command_jobs store / queue
             │
             ▼
       agent worker process
         ├─ claims pending jobs
         ├─ clones or opens project workspace
         ├─ runs configured agent backend
         ├─ streams or posts Slack thread updates
         └─ records terminal status
```

## 5. Executor taxonomy

### 5.1 `noop`

Purpose: safe route smoke test.

Behavior:

- No external agent call.
- Reply in Slack thread that route was accepted but no executor is active.

### 5.2 `routine`

Purpose: current production path.

Behavior:

- Validate `triggerId` and `tokenEnv`.
- Post accepted reply.
- Fire Claude routine.
- Post routine session URL or sanitized failure.

Keep this executor until worker/agent is proven.

### 5.3 `worker`

Purpose: enqueue command for a durable worker.

Behavior in hub:

- Validate route worker fields.
- Create or find an idempotent job record using Slack event identity before Slack ack.
- If job persistence fails, return non-2xx so Slack can retry rather than dropping the command.
- After ack, post accepted/queued reply with the pre-ack job ID.
- Return without running the agent inside the Vercel request lifecycle.

Behavior in worker:

- Claim queued job.
- Run agent backend.
- Post progress/final Slack thread replies.
- Mark job `succeeded`, `failed`, `cancelled`, or `needs_human`.

### 5.4 `agent`

Use `agent` either as:

1. A later alias of `worker` when the queue + worker exist, or
2. A direct executor only for short, bounded agent calls if the hosting platform can guarantee completion.

Recommendation: do not add direct `agent` execution on Vercel first. Treat `worker` as the safe executor and let the worker choose the agent backend.

## 6. Route config extension

Extend route objects without breaking current fields:

```json
{
  "channelId": "C_JULLYSSY",
  "project": "jullyssy-mall",
  "executor": "worker",
  "allowedUserIds": ["U_ALLOWED_USER"],
  "workerQueue": "default",
  "workspace": {
    "type": "git",
    "repo": "git@github.com:kaos1025/jullyssy-mall.git",
    "branch": "main"
  },
  "agent": {
    "backend": "claude-code",
    "profile": "default",
    "mode": "pr"
  },
  "policy": {
    "allowCommit": true,
    "allowFeatureBranchPush": true,
    "allowBaseBranchPush": false,
    "allowPrCreate": true,
    "requireHumanApprovalFor": ["deploy", "force-push", "delete", "payments", "secrets"]
  }
}
```

Field notes:

- `executor`: currently `noop` or `routine`; add `worker` first.
- `workerQueue`: logical queue name. Default: `default`.
- `workspace.repo`: Git remote to clone/open.
- `workspace.branch`: default base branch for jobs.
- `agent.backend`: implementation detail for the worker, not the hub.
- `policy`: route-local safety constraints. `allowFeatureBranchPush` is separate from `allowBaseBranchPush` so PR creation can be allowed without allowing direct protected/base branch pushes.

Do not put API keys, GitHub tokens, SSH keys, or Slack bot tokens inside `SLACK_ROUTES_JSON`.

## 7. Durable job model

A minimal `command_jobs` table or queue item should contain:

```text
id                  UUID / generated job ID
status              queued | running | succeeded | failed | cancelled | needs_human
project             route.project
executor            worker
queue               route.workerQueue
team_id             Slack team ID
enterprise_id       Slack enterprise ID, nullable
channel_id          Slack channel ID
user_id             Slack user ID
event_id            Slack event ID
message_ts          Slack message timestamp
thread_ts           Slack thread timestamp
command_text        Original Slack text
normalized_command  Optional parsed command body
route_snapshot      Sanitized route config snapshot, no secrets
attempt_count       Integer
claimed_by          Worker ID, nullable
claimed_at          Timestamp, nullable
started_at          Timestamp, nullable
finished_at         Timestamp, nullable
last_error          Sanitized error, nullable
created_at          Timestamp
updated_at          Timestamp
```

Recommended unique constraints:

- `team_id + event_id` when `event_id` exists.
- fallback `team_id + channel_id + message_ts`.

This replaces lightweight retry suppression with durable idempotency.

## 8. Hub responsibilities

The hub should remain small and deterministic:

1. Verify Slack signature.
2. Acknowledge quickly.
3. Parse command trigger.
4. Resolve route.
5. Enforce `allowedUserIds`.
6. Normalize command context.
7. Execute selected executor interface.
8. Post only sanitized status replies.

The hub should not:

- Clone repositories.
- Run long agent sessions.
- Store secret values in route JSON.
- Execute shell commands on behalf of Slack requests.
- Depend on `app_mention` without durable idempotency.

## 9. Worker responsibilities

The worker should:

1. Poll or subscribe to queued jobs.
2. Atomically claim one job at a time per workspace/project unless concurrency is explicitly safe.
3. Prepare workspace:
   - fresh clone, or
   - persistent worktree keyed by project, with clean state checks.
4. Run agent backend with command context and route policy.
5. Stream major milestones to Slack thread:
   - queued
   - started
   - needs approval
   - PR created
   - failed
   - completed
6. Persist job logs and final result.
7. Avoid leaking secrets into Slack replies.

## 10. Agent safety policy

Default worker policy should be conservative:

- Allowed by default:
  - inspect repository
  - edit files
  - run tests/lints/builds
  - create branch
  - commit changes
  - push feature branches when `allowFeatureBranchPush` is true
  - open PR
- Requires explicit approval or route opt-in:
  - push directly to protected/base branch
  - deploy production
  - force push
  - delete data/resources
  - modify secrets/env vars
  - process payments/orders in production systems
  - send external customer communications

Slack thread status should distinguish:

- `queued`: command accepted but not started
- `running`: agent is working
- `needs_human`: blocked on approval or missing credentials
- `succeeded`: final artifact available
- `failed`: sanitized error summary

## 11. Suggested implementation phases

### Phase 5A — Design + interfaces

Deliverables:

- This design doc.
- Route schema docs for future `worker` fields.
- Internal executor contract proposal.

No runtime behavior change.

### Phase 5B — Job persistence and idempotency

Deliverables:

- `command_jobs` persistence adapter.
- `worker` executor that performs an idempotent durable insert before Slack ack; if the insert/handoff cannot complete, the handler must return non-2xx so Slack can retry. Implemented with Supabase/PostgREST `command_jobs` insert + conflict lookup in Phase 5B.
- Existing job lookup on duplicate `event_id` / `message_ts` deliveries without merge-updating an already claimed/completed job.
- Verifier tests for:
  - duplicate Slack event returns existing job
  - malformed worker route fails closed
  - queued Slack thread reply
  - missing persistence config visible in thread

### Phase 5C — Worker skeleton

Deliverables:

- Worker CLI/process that claims jobs and marks them succeeded with a placeholder result.
- Heartbeat/claim timeout handling.
- Local verifier or integration script.

### Phase 5D — Agent backend adapter

Deliverables:

- Agent backend interface.
- First backend implementation, e.g. Claude Code/Agent SDK/other configured runner.
- Workspace preparation.
- Slack progress replies.
- Safety policy enforcement.

### Phase 5E — Production hardening

Deliverables:

- Job log retention policy.
- Retry/backoff policy.
- Dead-letter handling.
- Admin commands for retry/cancel/status.
- Metrics/alerts.

## 12. Minimal executor contract proposal

Split worker enqueue from post-ack side effects so the ack boundary is explicit:

```js
async function prepareExecutorBeforeAck({
  payload,
  env,
  route,
  command,
  adapters
}) {
  return {
    status: "ready" | "queued" | "duplicate" | "ignored",
    jobId: "optional pre-ack job id",
    ackStatus: 200
  };
}

async function runExecutorAfterAck({
  payload,
  env,
  route,
  command,
  preAckResult,
  postMessage,
  adapters
}) {
  return {
    status: "accepted" | "succeeded" | "failed" | "ignored",
    threadReplyText: "optional sanitized status text"
  };
}
```

For `worker`, `prepareExecutorBeforeAck` owns the durable insert/idempotency check and must fail the request if no durable handoff is possible. `runExecutorAfterAck` may only post duplicate-safe status replies using the pre-ack `jobId`. For `noop` and `routine`, `prepareExecutorBeforeAck` can be a pure validation/no-op step while existing post-ack behavior remains unchanged.

Executor modules should be pure around validation and take adapters for external effects. This keeps verifier tests fast and prevents hidden network calls.

## 13. First implementation recommendation

Implement `worker` as an enqueue-only executor before implementing a real agent runner.

Why:

- It gives durable idempotency, which is already needed for Slack retry correctness and future `app_mention` support.
- It avoids Vercel timeout risk.
- It lets us test route config, Slack replies, and job status UX without risking repo mutations.
- It keeps `routine` as the production fallback while the worker matures.

## 14. Open questions

1. Persistence backend: Supabase, Vercel Postgres, Upstash Redis/QStash, or GitHub Issues/Actions as an interim queue?
2. Worker hosting: long-running VPS, GitHub Actions workflow dispatch, Vercel Cron polling, or separate cloud worker?
3. Agent backend: Claude Code CLI, Anthropic Agent SDK, Hermes worker, or project-specific script runner?
4. Workspace credentials: deploy key per repo, GitHub App, or existing SSH identity?
5. Concurrency: one job per project, per repo, or per route?
6. Output artifact: Slack summary only, PR by default, or branch + patch file?
7. Human approval path: Slack reaction/button, `/approve` command, GitHub PR review, or Telegram approval?
