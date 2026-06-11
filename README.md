# Slack Webhook Hub

Minimal Slack webhook hub with channel-based routing and a swappable execution backend.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set `SLACK_SIGNING_SECRET` from the Slack app's Basic Information page.
3. Set `SLACK_BOT_TOKEN` to the bot token used for `chat.postMessage`.
4. Configure either legacy single-project routing or multi-project routing.
5. Run `npm install`, then `npm run dev`.

Configure Slack Event Subscriptions to send requests to:

```text
https://<your-host>/api/slack/events
```

The endpoint verifies Slack signatures, handles `url_verification`, immediately acknowledges `event_callback`, ignores Slack retry deliveries to avoid duplicate routine fires, routes `클로드,` commands by Slack channel ID, and dispatches them to the configured executor. Replies are posted back to the source Slack thread.

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

`SLACK_ROUTINE_PROJECT` is optional and only affects the human-readable project name included in Slack replies and routine context.

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
  }
]'
ROUTINE_TOKEN_JULLYSSY=your-jullyssy-routine-token
```

Route fields:

- `channelId` — Slack channel ID to accept commands from.
- `project` — human-readable project name included in routine context and Slack replies.
- `executor` — `routine` or `noop`; omitted defaults to `routine`.
- `triggerId` — Claude routine trigger ID, required for `routine` routes.
- `tokenEnv` — env var name containing that route's routine token; omitted defaults to `ROUTINE_TOKEN`.
- `allowedUserIds` — optional Slack user ID allowlist for this route. Omit it or set an empty array to allow any user in the routed channel. When set, commands from other users are rejected in the Slack thread and no executor is run. If present, it must be an array of non-empty strings; malformed values invalidate the route instead of failing open.

Keep routine tokens in separate env vars; do not place secret tokens inside `SLACK_ROUTES_JSON`.

## Slack retry handling

Slack may redeliver the same event with `X-Slack-Retry-Num` and `X-Slack-Retry-Reason` when it thinks a previous delivery failed or timed out. The hub verifies the Slack signature first, then returns `{ ok: true, ignored: "slack_retry" }` without running an executor or posting a Slack thread reply. This lightweight guard prevents duplicate routine fires without adding a database-backed idempotency store yet. Tradeoff: until an `event_id` idempotency store exists, a retry for a first delivery that truly failed before scheduling work can be dropped; add durable event logging before changing this into full exactly-once processing.

## Verification

Run the local behavior verifier:

```bash
npm run verify:slack
```

This checks signed challenge handling, signed event ack behavior, Slack retry suppression, legacy routine compatibility, noop executor replies, unsupported executor handling, multi-route routine dispatch, route-level user allowlist rejection, multi-route noop dispatch, unrouted-channel skip behavior, missing config skip behavior, Slack thread replies, stale request rejection, and invalid signature rejection.
