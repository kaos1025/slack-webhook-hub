# Slack Webhook Hub

Minimal Phase 1 Slack webhook hub.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set `SLACK_SIGNING_SECRET` from the Slack app's Basic Information page.
3. Set `SLACK_BOT_TOKEN` to the bot token used for `chat.postMessage`.
4. Set `SLACK_ECHO_CHANNEL_ID` to the one channel allowed to receive echo replies.
5. Run `npm install`, then `npm run dev`.

Configure Slack Event Subscriptions to send requests to:

```text
https://<your-host>/api/slack/events
```

The Phase 1 endpoint verifies Slack signatures, handles `url_verification`, immediately acknowledges `event_callback`, and posts a simple thread reply only for `SLACK_ECHO_CHANNEL_ID`.

## Verification

Run the local behavior verifier:

```bash
npm run verify:slack
```

This checks signed challenge handling, signed event ack behavior, allowed-channel echo dispatch, disallowed-channel skip behavior, and invalid signature rejection.
