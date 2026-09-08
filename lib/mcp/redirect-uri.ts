// Loopback hosts permitted for plaintext http redirect URIs (RFC 8252 §7.3).
// Node's WHATWG URL parser returns the IPv6 loopback host with brackets,
// hence "[::1]".
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * OAuth 2.1 Security BCP redirect_uri allowlist for Dynamic Client
 * Registration. Permits https for any host, plaintext http only for
 * loopback (native-app / RFC 8252 flows), and rejects every other scheme
 * (javascript:, data:, file:, intent:, custom app schemes, etc.) and any
 * non-loopback http URI. Unparseable values are rejected.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol === "http:") {
    return LOOPBACK_HOSTS.has(parsed.hostname);
  }
  return false;
}
