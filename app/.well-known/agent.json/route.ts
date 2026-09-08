// KEEP-475: /.well-known/agent.json used to 404 even though the A2A card
// has lived at /.well-known/agent-card.json since the ERC-8004 work
// (commit 575a584b). Some clients probe `agent.json` first per the older
// A2A draft, so a 301 to the canonical path keeps them working without
// duplicating card content in two places.

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  return Response.redirect(`${baseUrl}/.well-known/agent-card.json`, 301);
}
