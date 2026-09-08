/**
 * Unit tests for the root request proxy: CSRF and mandatory-MFA gates.
 * Pairs with the in-handler checks in `lib/middleware/auth-helpers.ts`
 * (CSRF) and `lib/middleware/owner-mfa-guard.ts` (per-action MFA).
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockGateCountry,
  mockResolveDevice,
  mockReadDeviceCookie,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGateCountry: vi.fn(),
  mockResolveDevice: vi.fn(),
  mockReadDeviceCookie: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));
// The country gate's collaborators are mocked so the proxy wiring can be
// driven directly. proxy.ts is their only importer here, so full replacements
// keep the real DB/Redis/header stack out of these tests.
vi.mock("@/lib/security/login-risk", () => ({
  gateRequestCountry: mockGateCountry,
}));
vi.mock("@/lib/security/device-trust", () => ({
  resolveSigninDevice: mockResolveDevice,
}));
vi.mock("@/lib/device-cookie", () => ({
  readDeviceCookie: mockReadDeviceCookie,
}));

import { proxy } from "@/proxy";

function make(
  pathname: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): NextRequest {
  return new NextRequest(new URL(pathname, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers: new Headers(init.headers ?? {}),
  });
}

// Safe defaults for the country gate so existing CSRF/MFA tests that fall
// through to it pass exactly as before (no CF country -> pass, no device work).
beforeEach(() => {
  mockGateCountry.mockReset();
  mockGateCountry.mockResolvedValue({ kind: "no_country" });
  mockResolveDevice.mockReset();
  mockResolveDevice.mockResolvedValue(null);
  mockReadDeviceCookie.mockReset();
  mockReadDeviceCookie.mockReturnValue(null);
});

describe("CSRF proxy", () => {
  beforeEach(() => {
    // Default: no session — keeps existing CSRF tests untouched by the
    // MFA gate, which short-circuits when getSession returns null.
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(null);
  });

  it("passes GET requests without inspection", async () => {
    const res = await proxy(
      make("/api/workflows", {
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("passes HEAD and OPTIONS without inspection", async () => {
    for (const method of ["HEAD", "OPTIONS"]) {
      const res = await proxy(
        make("/api/workflows", {
          method,
          headers: {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
        })
      );
      expect(res.status).toBe(200);
    }
  });

  it("passes cookieless POST (Bearer/API-key callers)", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: { Authorization: "Bearer kh_test" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("treats empty Cookie: header as no cookies", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: { cookie: "", origin: "https://evil.example.com" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("bypasses when only non-session cookies are present (CF Access tokens)", async () => {
    // Bearer/API-key callers behind Cloudflare Access carry CF cookies
    // but no better-auth session — they shouldn't be gated.
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "CF_AppSession=abc; CF_Authorization=xyz",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("bypasses when only unrelated tracking cookies are present", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "_ga=GA1.2.123; _gid=GA1.2.456",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("enforces when session cookie is present alongside CF cookies (real browser)", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie:
            "CF_AppSession=abc; __Secure-better-auth.session_token=tok; _ga=x",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  it("blocks cookie POST with untrusted origin", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  it("blocks cookie POST with missing origin and no referer", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: { cookie: "better-auth.session_token=abc" },
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  it("falls back to Referer when Origin is absent", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          referer: "http://localhost:3000/some/page",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("allows trusted origin (exact match)", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "http://localhost:3000",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("allows trusted origin (wildcard subdomain)", async () => {
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "https://app.keeperhub.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("checks PUT, PATCH, and DELETE", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await proxy(
        make("/api/workflows", {
          method,
          headers: {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
        })
      );
      expect(res.status).toBe(403);
    }
  });

  describe("exempt paths", () => {
    const exemptPaths = [
      "/api/auth/sign-in",
      "/api/auth/anything/nested",
      "/api/billing/webhooks/stripe",
      "/api/cron/agentic-wallet-sweeper",
      "/api/oauth/register",
      "/api/oauth/token",
      "/api/workflows/wf-123/webhook",
      "/api/workflows/wf-123/webhook/anything",
      "/api/mcp/workflows/some-slug/call",
    ];

    for (const path of exemptPaths) {
      it(`bypasses ${path}`, async () => {
        const res = await proxy(
          make(path, {
            method: "POST",
            headers: {
              cookie: "better-auth.session_token=abc",
              origin: "https://evil.example.com",
            },
          })
        );
        expect(res.status).toBe(200);
      });
    }

    it("does NOT bypass /api/workflows/wf-123 (no trailing /webhook)", async () => {
      const res = await proxy(
        make("/api/workflows/wf-123", {
          method: "POST",
          headers: {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
        })
      );
      expect(res.status).toBe(403);
    });
  });
});

describe("MFA gate", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  function sessionCookieHeaders(): Record<string, string> {
    return {
      cookie: "better-auth.session_token=tok",
      origin: "http://localhost:3000",
    };
  }

  it("passes when there is no session cookie at all (API-key caller)", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await proxy(
      make("/api/workflows", {
        headers: { Authorization: "Bearer kh_test" },
      })
    );
    expect(res.status).toBe(200);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("passes when session cookie is present but resolves to no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await proxy(
      make("/api/workflows", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(200);
  });

  it("blocks an authenticated API request when twoFactorEnabled is false", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const res = await proxy(
      make("/api/workflows", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("mfa_enrollment_required");
  });

  it("blocks an authenticated API request when session.requiresMfa is true", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: true },
      session: { requiresMfa: true },
    });
    const res = await proxy(
      make("/api/workflows", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("mfa_pending");
  });

  it("allows an authenticated API request when twoFactorEnabled + verified", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: true },
      session: { requiresMfa: false },
    });
    const res = await proxy(
      make("/api/workflows", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(200);
  });

  it("passes anonymous API requests despite twoFactorEnabled being false", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "anon1",
        name: "Anonymous",
        email: "temp-abc@keeperhub.local",
        isAnonymous: true,
        twoFactorEnabled: false,
      },
      session: { requiresMfa: false },
    });
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: sessionCookieHeaders(),
      })
    );
    expect(res.status).toBe(200);
  });

  it("does not redirect anonymous page requests to /enroll-mfa", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "anon1",
        name: "Anonymous",
        email: "temp-abc@keeperhub.local",
        isAnonymous: true,
        twoFactorEnabled: false,
      },
      session: { requiresMfa: false },
    });
    const res = await proxy(make("/", { headers: sessionCookieHeaders() }));
    expect(res.status).toBe(200);
  });

  it("still blocks a real user who set their name to 'Anonymous' (not isAnonymous)", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "u1",
        name: "Anonymous",
        email: "real@example.com",
        isAnonymous: false,
        twoFactorEnabled: false,
      },
      session: { requiresMfa: false },
    });
    const res = await proxy(
      make("/api/workflows", {
        method: "POST",
        headers: sessionCookieHeaders(),
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("mfa_enrollment_required");
  });

  it("redirects authenticated page requests to /enroll-mfa when not enrolled", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const res = await proxy(
      make("/workflows", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/enroll-mfa");
    expect(location).toContain("next=%2Fworkflows");
  });

  it("redirects authenticated page requests to /verify-mfa when requiresMfa", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: true },
      session: { requiresMfa: true },
    });
    const res = await proxy(
      make("/workflows", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/verify-mfa");
  });

  it("does not block on the /enroll-mfa page itself", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const res = await proxy(
      make("/enroll-mfa", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(200);
  });

  it("does not block on the /verify-mfa page itself", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: true },
      session: { requiresMfa: true },
    });
    const res = await proxy(
      make("/verify-mfa", { headers: sessionCookieHeaders() })
    );
    expect(res.status).toBe(200);
  });

  it("does not block /api/auth/* (sign-in, sign-out, two-factor)", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    for (const path of [
      "/api/auth/sign-out",
      "/api/auth/two-factor/verify-totp",
    ]) {
      const res = await proxy(
        make(path, { method: "POST", headers: sessionCookieHeaders() })
      );
      expect(res.status).toBe(200);
    }
  });

  it("does not block /api/user/totp/* (enrollment + step-up endpoints)", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    for (const path of [
      "/api/user/totp/setup",
      "/api/user/totp/enroll",
      "/api/user/totp/status",
      "/api/user/totp/verify-stepup",
    ]) {
      const res = await proxy(
        make(path, { method: "POST", headers: sessionCookieHeaders() })
      );
      expect(res.status).toBe(200);
    }
  });

  it("does not block the exempt public pages for signed-in users", async () => {
    // Was ["/pricing", "/docs/getting-started"]. /pricing was one of four
    // entries in MFA_EXEMPT_PAGES that named routes this app has never served
    // (/pricing, /about, /terms, /privacy); they now live on keeperhub.com and
    // the exempt list only names routes that exist.
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    for (const path of ["/welcome", "/docs/getting-started"]) {
      const res = await proxy(make(path, { headers: sessionCookieHeaders() }));
      expect(res.status).toBe(200);
    }
  });

  it("gates signed-in users on the root path", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const res = await proxy(make("/", { headers: sessionCookieHeaders() }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/enroll-mfa");
  });

  it("redirects signed-out visitors from the root path to welcome", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await proxy(make("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/welcome");
  });
});

describe("MFA gate: load-test bypass header", () => {
  const BYPASS_TOKEN = "load-test-bypass-token-32-bytes-long!";
  const SAME_LENGTH_WRONG = "WRONG-TOKEN-DIFFERENT-VALUE-XXXXXXXXX";

  function sessionCookieHeaders(): Record<string, string> {
    return {
      cookie: "better-auth.session_token=tok",
      origin: "http://localhost:3000",
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockGetSession.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function loadProxyWithBypassTokenSet(): Promise<typeof proxy> {
    vi.stubEnv("LOAD_TEST_BYPASS_TOKEN", BYPASS_TOKEN);
    const mod = await import("@/proxy");
    return mod.proxy;
  }

  it("passes an authenticated API request when the bypass header matches", async () => {
    expect(SAME_LENGTH_WRONG.length).toBe(BYPASS_TOKEN.length);
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const proxyFn = await loadProxyWithBypassTokenSet();
    const res = await proxyFn(
      make("/api/workflows", {
        headers: {
          ...sessionCookieHeaders(),
          "x-load-test-mfa-bypass": BYPASS_TOKEN,
        },
      })
    );
    expect(res.status).toBe(200);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("does not honor a same-length but wrong bypass header", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const proxyFn = await loadProxyWithBypassTokenSet();
    const res = await proxyFn(
      make("/api/workflows", {
        headers: {
          ...sessionCookieHeaders(),
          "x-load-test-mfa-bypass": SAME_LENGTH_WRONG,
        },
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("mfa_enrollment_required");
  });

  it("does not honor a wrong-length bypass header", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const proxyFn = await loadProxyWithBypassTokenSet();
    const res = await proxyFn(
      make("/api/workflows", {
        headers: {
          ...sessionCookieHeaders(),
          "x-load-test-mfa-bypass": "too-short",
        },
      })
    );
    expect(res.status).toBe(403);
  });

  it("ignores the bypass header entirely when the env token is unset", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", twoFactorEnabled: false },
      session: { requiresMfa: false },
    });
    const mod = await import("@/proxy");
    const res = await mod.proxy(
      make("/api/workflows", {
        headers: {
          ...sessionCookieHeaders(),
          "x-load-test-mfa-bypass": BYPASS_TOKEN,
        },
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("mfa_enrollment_required");
  });
});

describe("Country gate", () => {
  // Authenticated, enrolled, MFA-verified user with an email so mfaBlock
  // returns a real user and the country gate runs.
  const VERIFIED_USER = {
    user: { id: "u1", email: "a@b.com", twoFactorEnabled: true },
    session: { requiresMfa: false },
  };

  function gateHeaders(): Record<string, string> {
    return {
      cookie: "better-auth.session_token=tok",
      origin: "http://localhost:3000",
    };
  }

  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(VERIFIED_USER);
    // encodePendingIpCookie needs a signing secret for the untrusted path.
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-please-ignore");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes a trusted-country request through", async () => {
    mockGateCountry.mockResolvedValue({ kind: "trusted" });
    mockReadDeviceCookie.mockReturnValue("kh_device_id=existing");
    const res = await proxy(make("/dashboard", { headers: gateHeaders() }));
    expect(res.status).toBe(200);
    expect(mockResolveDevice).not.toHaveBeenCalled();
  });

  it("passes when CF attested no country", async () => {
    mockGateCountry.mockResolvedValue({ kind: "no_country" });
    const res = await proxy(make("/dashboard", { headers: gateHeaders() }));
    expect(res.status).toBe(200);
  });

  it("redirects a page navigation to /verify-ip on an untrusted country", async () => {
    mockGateCountry.mockResolvedValue({
      kind: "untrusted",
      country: "DE",
      ip: "9.9.9.9",
    });
    const res = await proxy(make("/dashboard", { headers: gateHeaders() }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/verify-ip");
    expect(res.headers.get("set-cookie")).toContain("pending_ip_verify");
  });

  it("returns 403 ip_verification_required for an untrusted-country API call", async () => {
    mockGateCountry.mockResolvedValue({
      kind: "untrusted",
      country: "DE",
      ip: "9.9.9.9",
    });
    const res = await proxy(make("/api/workflows", { headers: gateHeaders() }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ip_verification_required");
  });

  it("passes (no verify cookie) when an untrusted country has no resolvable IP", async () => {
    mockGateCountry.mockResolvedValue({
      kind: "untrusted",
      country: "DE",
      ip: null,
    });
    const res = await proxy(make("/dashboard", { headers: gateHeaders() }));
    expect(res.status).toBe(200);
  });

  it("adopts the device cookie on a document navigation lacking one", async () => {
    mockGateCountry.mockResolvedValue({ kind: "trusted" });
    mockReadDeviceCookie.mockReturnValue(null);
    mockResolveDevice.mockResolvedValue(
      "kh_device_id=minted; Path=/; HttpOnly"
    );
    const res = await proxy(
      make("/dashboard", {
        headers: { ...gateHeaders(), "sec-fetch-dest": "document" },
      })
    );
    expect(res.status).toBe(200);
    expect(mockResolveDevice).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", notifyOnNew: false })
    );
    expect(res.headers.get("set-cookie")).toContain("kh_device_id=");
  });

  it("does not adopt a device on non-document subrequests (fan-out guard)", async () => {
    mockGateCountry.mockResolvedValue({ kind: "trusted" });
    mockReadDeviceCookie.mockReturnValue(null);
    const res = await proxy(
      make("/api/workflows", {
        headers: { ...gateHeaders(), "sec-fetch-dest": "empty" },
      })
    );
    expect(res.status).toBe(200);
    expect(mockResolveDevice).not.toHaveBeenCalled();
  });
});

/**
 * Content negotiation gate. Runs before every auth gate, so these tests use the
 * default "no session" mocks from the CSRF suite above.
 */
describe("markdown content negotiation", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(null);
  });

  const MD = { accept: "text/markdown" };

  it("serves markdown at / instead of redirecting to /welcome", async () => {
    // The whole point: an agent asking `/` for markdown is answered at the URL
    // it asked about, rather than 307'd into a sign-in page.
    const res = await proxy(make("/", { headers: MD }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    const body = await res.text();
    expect(body.startsWith("# ")).toBe(true);
    expect(body).toContain("## What KeeperHub does");
  });

  it("answers /welcome with the same document as /", async () => {
    const [root, welcome] = await Promise.all([
      proxy(make("/", { headers: MD })).then((res) => res.text()),
      proxy(make("/welcome", { headers: MD })).then((res) => res.text()),
    ]);
    expect(welcome).toBe(root);
  });

  it("serves markdown for every negotiable path", async () => {
    // Only / and /welcome now: the five app-side pages were removed once they
    // turned out to duplicate keeperhub.com and docs.keeperhub.com.
    const { NEGOTIABLE_PATHS } = await import("@/lib/site/content");
    expect(NEGOTIABLE_PATHS).toEqual(["/", "/welcome"]);
    for (const path of NEGOTIABLE_PATHS) {
      const res = await proxy(make(path, { headers: MD }));
      expect(res.status, `${path} did not negotiate`).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "text/markdown; charset=utf-8"
      );
    }
  });

  it("sets Vary: Accept on the markdown branch", async () => {
    const res = await proxy(make("/", { headers: MD }));
    expect(res.headers.get("vary")).toBe("Accept, Accept-Encoding");
  });

  it("sets Vary: Accept on the / -> /welcome redirect", async () => {
    // The redirect is a proxy-returned response, so this header survives to the
    // wire. On responses that go on to render a page, Next.js replaces `Vary`
    // with its own RSC value - see the note on the negotiation gate.
    const res = await proxy(make("/", { headers: { accept: "text/html" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("vary")).toContain("Accept");
  });

  it("advertises the canonical URL on the markdown response", async () => {
    const res = await proxy(make("/welcome", { headers: MD }));
    // /welcome resolves to the homepage SitePage, so it canonicalises to "/".
    expect(res.headers.get("link")).toBe(
      '<http://localhost:3000/>; rel="canonical"'
    );
  });

  it("still redirects a browser at / to /welcome", async () => {
    const res = await proxy(
      make("/", {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/welcome");
  });

  it("still redirects a client that sends no Accept header", async () => {
    const res = await proxy(make("/"));
    expect(res.status).toBe(307);
  });

  it("answers 406 when the client accepts neither representation", async () => {
    const res = await proxy(
      make("/", { headers: { accept: "application/json" } })
    );
    expect(res.status).toBe(406);
    expect(res.headers.get("vary")).toBe("Accept, Accept-Encoding");
    expect(await res.text()).toContain("406 Not Acceptable");
  });

  it("returns no body for HEAD but keeps the headers", async () => {
    const res = await proxy(make("/", { method: "HEAD", headers: MD }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(await res.text()).toBe("");
  });

  it("leaves non-GET methods to the normal pipeline", async () => {
    const res = await proxy(make("/", { method: "POST", headers: MD }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).not.toBe(
      "text/markdown; charset=utf-8"
    );
  });

  it("ignores RSC navigation fetches", async () => {
    // Next.js router fetches carry an `rsc` header and a permissive Accept.
    // Answering them with markdown would break client-side navigation.
    const res = await proxy(
      make("/pricing", { headers: { accept: "text/markdown", rsc: "1" } })
    );
    expect(res.headers.get("content-type")).not.toBe(
      "text/markdown; charset=utf-8"
    );
  });

  it("does not negotiate paths outside the public set", async () => {
    const res = await proxy(make("/settings", { headers: MD }));
    expect(res.headers.get("content-type")).not.toBe(
      "text/markdown; charset=utf-8"
    );
    expect(res.headers.get("vary")).toBeNull();
  });

  it("does not negotiate API routes", async () => {
    const res = await proxy(make("/api/chains", { headers: MD }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).not.toBe(
      "text/markdown; charset=utf-8"
    );
  });

  it("does not exempt paths that have no page behind them", async () => {
    // /terms was exempt for a long time with nothing to serve. The list reads
    // as the inventory of public pages, so a dangling entry makes a page look
    // shipped when it 404s.
    const { proxy: freshProxy } = await import("@/proxy");
    expect(typeof freshProxy).toBe("function");
    const { PUBLIC_PAGE_PATHS } = await import("@/lib/site/content");
    expect(PUBLIC_PAGE_PATHS).not.toContain("/terms");
  });
});
