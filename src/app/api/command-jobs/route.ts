import { handleCommandJobsDashboardRequest } from "@/lib/command-jobs-dashboard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleCommandJobsDashboardRequest({
    requestUrl: request.url,
    headers: request.headers,
    env: process.env
  });
}
