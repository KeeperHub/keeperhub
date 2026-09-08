import { normalizeIpForTrust } from "@/lib/security/ip-normalize";

/**
 * Decide whether the current request's network matches the one pinned in the
 * `pending_ip_verify` cookie at strict-signin time.
 *
 * The session-minting path MUST fail closed when the client IP cannot be
 * resolved. In production a null IP means the request reached the origin
 * without a `CF-Connecting-IP` header (direct-origin access / Cloudflare
 * bypass); letting it through would skip the entire IP binding this endpoint
 * exists to enforce, which is exactly the F-016 / KEEP-741 fail-open. Outside
 * production `resolveClientIpFromHeaders` has no CF header to read, so a null
 * IP there is the local-dev case and still passes.
 *
 * When an IP is present, both sides are normalized to the /24-or-/64 network so
 * a user whose egress IP rotates within their subnet mid-flow isn't bounced.
 */
export function isVerifyIpMatch(
  currentRawIp: string | null,
  cookieIp: string
): boolean {
  if (currentRawIp === null) {
    return process.env.NODE_ENV !== "production";
  }
  return normalizeIpForTrust(currentRawIp) === normalizeIpForTrust(cookieIp);
}
