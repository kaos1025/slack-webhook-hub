# Slack Webhook Hub

Minimal Phase 2 Slack webhook hub.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set `SLACK_SIGNING_SECRET` from the Slack app's Basic Information page.
3. Set `SLACK_BOT_TOKEN` to the bot token used for `chat.postMessage`.
4. Set `SLACK_ROUTINE_CHANNEL_ID` to the one Slack channel routed to the routine.
5. Set `SLACK_ROUTINE_TRIGGER_ID` to the Claude routine trigger ID.
6. Set `ROUTINE_TOKEN` to the token generated for that routine trigger.
7. Run `npm install`, then `npm run dev`.

Configure Slack Event Subscriptions to send requests to:

```text
https://<your-host>/api/slack/events
```

The Phase 2 endpoint verifies Slack signatures, handles `url_verification`, immediately acknowledges `event_callback`, fires the configured Claude routine for `클로드,` commands in `SLACK_ROUTINE_CHANNEL_ID`, and posts the returned session URL back to the Slack thread.

## Verification

Run the local behavior verifier:

```bash
npm run verify:slack
```

This checks signed challenge handling, signed event ack behavior, routine fire dispatch, unrouted-channel skip behavior, missing config skip behavior, Slack thread replies, and invalid signature rejection.
