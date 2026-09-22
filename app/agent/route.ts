// KEEP-475: ERC-8004 indexers and older A2A clients sometimes probe the bare
// `/agent` path before falling back to `/.well-known/agent.json` or
// `/.well-known/agent-card.json`. Without this route they got a 404 and gave
// up; a 301 keeps them on the canonical card without duplicating content.

import { stripTrailingSlashes } from "@/lib/utils/url";

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return stripTrailingSlashes(envUrl);
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  return Response.redirect(`${baseUrl}/.well-known/agent-card.json`, 301);
}
