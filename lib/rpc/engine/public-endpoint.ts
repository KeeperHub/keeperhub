import "server-only";

import { resolvePublicAddresses } from "@/lib/safe-fetch";

/** URL schemes the public-host check understands, for each WebSocket scheme. */
const WS_TO_HTTP_SCHEME: Readonly<Record<string, string>> = {
  "ws:": "http:",
  "wss:": "https:",
};

/**
 * The public addresses an RPC endpoint's host resolves to. Throws when the
 * host is internal or does not resolve, as the save-time check does.
 */
export function resolveEndpointAddresses(url: string): Promise<string[]> {
  const parsed = new URL(url);
  const httpScheme = WS_TO_HTTP_SCHEME[parsed.protocol];
  if (httpScheme) {
    parsed.protocol = httpScheme;
  }
  return resolvePublicAddresses(parsed.toString());
}
