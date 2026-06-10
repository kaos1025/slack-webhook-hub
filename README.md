# Slack Webhook Hub

Minimal Slack webhook hub with a swappable execution backend.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set `SLACK_SIGNING_SECRET` from the Slack app's Basic Information page.
3. Set `SLACK_BOT_TOKEN` to the bot token used for `chat.postMessage`.
4. Set `SLACK_EXECUTOR` to the execution backend:
   - `routine` fires the configured Claude routine. This is the default when `SLACK_EXECUTOR` is unset.
   - `noop` does not call Claude routine. It replies in the Slack thread that the command was accepted but no executor is active.
5. Set `SLACK_ROUTINE_CHANNEL_ID` to the one Slack channel routed by this hub.
6. For `SLACK_EXECUTOR=routine`, set `SLACK_ROUTINE_TRIGGER_ID` to the Claude routine trigger ID.
7. For `SLACK_EXECUTOR=routine`, set `ROUTINE_TOKEN` to the token generated for that routine trigger.
8. Run `npm install`, then `npm run dev`.

Configure Slack Event Subscriptions to send requests to:

```text
https://<your-host>/api/slack/events
```

The endpoint verifies Slack signatures, handles `url_verification`, immediately acknowledges `event_callback`, routes `클로드,` commands from `SLACK_ROUTINE_CHANNEL_ID`, and dispatches them to the configured executor. With the default `routine` executor it fires the configured Claude routine and posts the returned session URL back to the Slack thread. With `noop`, it only posts an accepted/no-active-executor reply in the Slack thread.

## Verification

Run the local behavior verifier:

```bash
npm run verify:slack
```

This checks signed challenge handling, signed event ack behavior, routine executor dispatch, default routine compatibility, noop executor replies, unsupported executor handling, unrouted-channel skip behavior, missing config skip behavior, Slack thread replies, stale request rejection, and invalid signature rejection.
