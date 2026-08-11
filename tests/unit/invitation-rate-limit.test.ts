import { afterEach, describe, expect, it } from "vitest";
import {
  __resetInviteFetchRateLimitForTests,
  checkInviteFetchRateLimit,
  getInviteFetchRateLimitKey,
} from "@/app/api/invitations/_lib/rate-limit";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/invitations/test", { headers });
}

afterEach(() => {
  __resetInviteFetchRateLimitForTests();
});

describe("getInviteFetchRateLimitKey", () => {
  it("buckets by Cloudflare cf-connecting-ip when present", () => {
    expect(
      getInviteFetchRateLimitKey(
        makeRequest({ "cf-connecting-ip": "203.0.113.7" })
      )
    ).toBe("ip:203.0.113.7");
  });

  it("ignores spoofed x-forwarded-for when no trusted proxy is the peer", () => {
    // An untrusted caller setting XFF must not be able to rotate buckets.
    // With no cf-connecting-ip and no trusted-proxy peer, the limiter must
    // collapse to the unknown bucket instead of trusting the XFF value.
    const req = makeRequest({
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    });
    expect(getInviteFetchRateLimitKey(req)).toBe("ip:unknown");
  });

  it("honours x-forwarded-for only when peer is a Cloudflare IP", () => {
    // 162.158.0.5 sits in a CF CIDR per lib/security/trusted-proxies.ts.
    // In that case XFF[0] is the real client and is safe to use.
    const req = makeRequest({
      "x-real-ip": "162.158.0.5",
      "x-forwarded-for": "203.0.113.99, 162.158.0.5",
    });
    expect(getInviteFetchRateLimitKey(req)).toBe("ip:203.0.113.99");
  });

  it("falls back to unknown bucket when no source is present", () => {
    expect(getInviteFetchRateLimitKey(makeRequest())).toBe("ip:unknown");
  });
});

describe("checkInviteFetchRateLimit", () => {
  it("allows the first 60 requests then blocks", () => {
    const key = "ip:203.0.113.7";
    for (const _ of Array.from({ length: 60 })) {
      expect(checkInviteFetchRateLimit(key).allowed).toBe(true);
    }
    const blocked = checkInviteFetchRateLimit(key);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
    }
  });

  it("isolates buckets so two IPs share independent windows", () => {
    const ipA = "ip:203.0.113.1";
    const ipB = "ip:203.0.113.2";
    for (const _ of Array.from({ length: 60 })) {
      checkInviteFetchRateLimit(ipA);
    }
    expect(checkInviteFetchRateLimit(ipA).allowed).toBe(false);
    expect(checkInviteFetchRateLimit(ipB).allowed).toBe(true);
  });

  it("collapses spoofed-XFF callers into the shared unknown bucket", () => {
    // Behavioural assertion that pins the fix in place: requests from the
    // same untrusted peer that rotate `x-forwarded-for` per call all share
    // the "ip:unknown" bucket, so they cannot evade the limit.
    const reqA = makeRequest({ "x-forwarded-for": "1.1.1.1" });
    const reqB = makeRequest({ "x-forwarded-for": "2.2.2.2" });
    expect(getInviteFetchRateLimitKey(reqA)).toBe("ip:unknown");
    expect(getInviteFetchRateLimitKey(reqB)).toBe("ip:unknown");
  });
});
