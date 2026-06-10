import {
  fireClaudeRoutine,
  handleSlackEventsRequest,
  postSlackThreadReply
} from "@/lib/slack-events";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();

  return handleSlackEventsRequest({
    rawBody,
    headers: request.headers,
    env: process.env,
    fireRoutine: fireClaudeRoutine,
    postMessage: postSlackThreadReply
  });
}
