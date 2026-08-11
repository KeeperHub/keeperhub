import { getCookies } from "better-auth/cookies";
import { describe, expect, it } from "vitest";
import {
  hasSessionCookie,
  isTrustedOrigin,
  normaliseOrigin,
  SESSION_COOKIE_RE,
} from "@/lib/trusted-origins";

describe("isTrustedOrigin", () => {
  it("matches any localhost port (worktree dev servers can run on any port)", () => {
    expect(isTrustedOrigin("http://localhost:3000")).toBe(true);
    expect(isTrustedOrigin("http://localhost:3001")).toBe(true);
    expect(isTrustedOrigin("http://localhost:4000")).toBe(true);
  });

  it("matches subdomains via *.keeperhub.com", () => {
    expect(isTrustedOrigin("https://app.keeperhub.com")).toBe(true);
    expect(isTrustedOrigin("https://docs.keeperhub.com")).toBe(true);
    expect(isTrustedOrigin("https://app-staging.keeperhub.com")).toBe(true);
  });

  it("matches dynamic ports on 127.0.0.1 (CLI auth callback)", () => {
    expect(isTrustedOrigin("http://127.0.0.1:55432")).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:1234")).toBe(true);
  });

  it("rejects untrusted origins", () => {
    expect(isTrustedOrigin("https://evil.example.com")).toBe(false);
    expect(isTrustedOrigin("https://keeperhub.com.evil.example")).toBe(false);
  });

  it("rejects scheme mismatches for keeperhub.com (must be https)", () => {
    expect(isTrustedOrigin("http://app.keeperhub.com")).toBe(false);
  });

  it("rejects https://localhost in non-dev environments", () => {
    // DEV_HTTPS_ORIGINS is only populated when NODE_ENV === "development".
    // Tests run under NODE_ENV=test, so https://localhost must not be trusted
    // here even though pnpm dev:https requires it locally for SIWE wallets.
    expect(isTrustedOrigin("https://localhost:3000")).toBe(false);
    expect(isTrustedOrigin("https://127.0.0.1:3000")).toBe(false);
  });

  it("rejects inputs that include a path (must be a bare origin)", () => {
    // isTrustedOrigin expects normaliseOrigin output, which strips paths.
    // This guards against accidental misuse if a caller skips normalisation.
    expect(isTrustedOrigin("https://app.keeperhub.com/foo")).toBe(false);
    expect(isTrustedOrigin("https://app.keeperhub.com/../evil")).toBe(false);
  });
});

describe("normaliseOrigin", () => {
  it("returns the origin portion of a full URL", () => {
    expect(normaliseOrigin("https://app.keeperhub.com/foo/bar?x=1")).toBe(
      "https://app.keeperhub.com"
    );
  });

  it("returns the origin when given just an origin", () => {
    expect(normaliseOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000"
    );
  });

  it("returns null for empty, null, or 'null' values", () => {
    expect(normaliseOrigin(null)).toBeNull();
    expect(normaliseOrigin(undefined)).toBeNull();
    expect(normaliseOrigin("")).toBeNull();
    expect(normaliseOrigin("null")).toBeNull();
  });

  it("returns null for unparseable values", () => {
    expect(normaliseOrigin("not a url")).toBeNull();
    expect(normaliseOrigin("/relative/path")).toBeNull();
  });
});

describe("hasSessionCookie", () => {
  function headers(cookie?: string): Headers {
    return new Headers(cookie === undefined ? {} : { cookie });
  }

  it("returns false when no Cookie header is present", () => {
    expect(hasSessionCookie(headers())).toBe(false);
  });

  it("returns false when Cookie header is empty", () => {
    expect(hasSessionCookie(headers(""))).toBe(false);
  });

  it("returns false when only non-session cookies are present", () => {
    expect(
      hasSessionCookie(headers("CF_AppSession=a; CF_Authorization=b"))
    ).toBe(false);
    expect(hasSessionCookie(headers("_ga=GA1.2.123; _gid=GA1.2.456"))).toBe(
      false
    );
    expect(hasSessionCookie(headers("sidebar-collapsed=false"))).toBe(false);
  });

  it("returns true for the dev cookie name (no Secure prefix)", () => {
    expect(hasSessionCookie(headers("better-auth.session_token=abc"))).toBe(
      true
    );
  });

  it("returns true for the prod cookie name (Secure prefix)", () => {
    expect(
      hasSessionCookie(headers("__Secure-better-auth.session_token=abc"))
    ).toBe(true);
  });

  it("returns true when session cookie is mixed with unrelated cookies", () => {
    expect(
      hasSessionCookie(
        headers(
          "CF_AppSession=a; __Secure-better-auth.session_token=tok; _ga=x"
        )
      )
    ).toBe(true);
  });
});

describe("SESSION_COOKIE_RE boundary anchoring", () => {
  // The regex must reject lookalikes that could otherwise sneak past a plain
  // substring check.

  it("rejects the substring appearing inside a cookie value", () => {
    expect(SESSION_COOKIE_RE.test("first=better-auth.session_token=evil")).toBe(
      false
    );
  });

  it("rejects an unrelated cookie name with the substring as suffix", () => {
    expect(SESSION_COOKIE_RE.test("xbetter-auth.session_token=foo")).toBe(
      false
    );
    expect(SESSION_COOKIE_RE.test("MyApp-better-auth.session_token=foo")).toBe(
      false
    );
  });

  it("accepts the cookie when separated by ; with or without whitespace", () => {
    expect(SESSION_COOKIE_RE.test("a=1;better-auth.session_token=tok")).toBe(
      true
    );
    expect(SESSION_COOKIE_RE.test("a=1; better-auth.session_token=tok")).toBe(
      true
    );
    expect(
      SESSION_COOKIE_RE.test("a=1;\t__Secure-better-auth.session_token=tok")
    ).toBe(true);
  });
});

describe("better-auth cookie name pinning", () => {
  // If better-auth ever renames its session cookie, our regex check in
  // proxy.ts and auth-helpers.ts becomes a no-op (silently disabling the
  // CSRF protection). This test imports the actual better-auth helper used
  // to generate cookie names and asserts our regex still matches, so a
  // future upgrade fails CI rather than silently weakening the gate.
  // See KEEP-240.

  it("matches the dev cookie name better-auth generates from default options", () => {
    const cookies = getCookies({} as Parameters<typeof getCookies>[0]);
    expect(cookies.sessionToken.name).toBe("better-auth.session_token");
    expect(SESSION_COOKIE_RE.test(`${cookies.sessionToken.name}=tok`)).toBe(
      true
    );
  });

  it("matches the prod cookie name better-auth generates with useSecureCookies", () => {
    const cookies = getCookies({
      advanced: { useSecureCookies: true },
    } as Parameters<typeof getCookies>[0]);
    expect(cookies.sessionToken.name).toBe(
      "__Secure-better-auth.session_token"
    );
    expect(SESSION_COOKIE_RE.test(`${cookies.sessionToken.name}=tok`)).toBe(
      true
    );
  });
});
