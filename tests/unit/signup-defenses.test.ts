import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RateLimitRule = { window: number; max: number };
type RateLimitRuleFn = (
  req: Request,
  defaults: RateLimitRule
) => Promise<RateLimitRule | false> | RateLimitRule | false;
type CaptchaPluginShape = {
  id: string;
  options: { provider?: string; endpoints?: string[]; secretKey?: string };
};

const TEST_API_KEY = "kha_test_signup_defenses_key";
const MISSING_CAPTCHA_SECRET_ERROR = /TURNSTILE_SECRET_KEY is required/;

function clearTurnstileEnv(): void {
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.TEST_API_KEY;
  delete process.env.INCLUDE_TEST_ENDPOINTS;
  delete process.env.ALLOW_TEST_ENDPOINTS;
  delete process.env.NEXT_PHASE;
  delete process.env.TURNSTILE_ENFORCE;
  delete process.env.TURNSTILE_DISABLED;
  delete process.env.LOAD_TEST_BYPASS_TOKEN;
}

describe("signup defenses: captcha plugin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  it("does not load the captcha plugin in test mode even when secret is set", async () => {
    vi.stubEnv("NODE_ENV", "test");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("does not load the captcha plugin when TURNSTILE_SECRET_KEY is missing outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("loads the captcha plugin gated to /sign-up/email when secret is set outside test mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    ) as CaptchaPluginShape | undefined;
    expect(plugin).toBeDefined();
    expect(plugin?.options.provider).toBe("cloudflare-turnstile");
    expect(plugin?.options.endpoints).toEqual(["/sign-up/email"]);
    expect(plugin?.options.secretKey).toBe("test-secret");
  });

  it("throws at module load in production when TURNSTILE_SECRET_KEY is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Pin CI off: a real prod deploy never sets CI=true, so the plugin is
    // enforced and the guard must fire. The CI runner sets CI=true ambiently,
    // which would otherwise skip the guard (see the CI=true case below).
    vi.stubEnv("CI", "");
    await expect(import("@/lib/auth")).rejects.toThrow(
      MISSING_CAPTCHA_SECRET_ERROR
    );
  });

  it("does not throw in production when CI=true even without the secret (ephemeral e2e boots the prod image with the plugin skipped)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "true");
    const { auth } = await import("@/lib/auth");
    expect(auth).toBeDefined();
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("does not throw during next build phase even without the secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const mod = await import("@/lib/auth");
    expect(mod.auth).toBeDefined();
    const plugin = (mod.auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("skips captcha plugin when admin test endpoints are enabled outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.TEST_API_KEY = "kha_admin_test";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("loads the captcha plugin when TURNSTILE_ENFORCE=true even with admin test endpoints enabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
    vi.stubEnv("TURNSTILE_ENFORCE", "true");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.TEST_API_KEY = "kha_admin_test";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    ) as CaptchaPluginShape | undefined;
    expect(plugin).toBeDefined();
    expect(plugin?.options.endpoints).toEqual(["/sign-up/email"]);
  });

  it("throws at module load when TURNSTILE_ENFORCE=true but the secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    vi.stubEnv("TURNSTILE_ENFORCE", "true");
    await expect(import("@/lib/auth")).rejects.toThrow(
      MISSING_CAPTCHA_SECRET_ERROR
    );
  });

  // A deployment that cannot use Cloudflare needs a way to boot that is not
  // CI=true. These cases fix what that opt-out does and, more importantly, what
  // it does not do when it is absent.
  describe("TURNSTILE_DISABLED opt-out", () => {
    it("boots in production without the secret", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CI", "");
      vi.stubEnv("TURNSTILE_DISABLED", "true");
      const { auth } = await import("@/lib/auth");
      expect(auth).toBeDefined();
      const plugin = (auth.options.plugins ?? []).find(
        (p) => (p as CaptchaPluginShape).id === "captcha"
      );
      expect(plugin).toBeUndefined();
    });

    // The point of the opt-out is no Cloudflare request. A leftover secret in
    // the deployment's config must not quietly reinstate one.
    it("loads no captcha plugin even when a secret is present", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CI", "");
      vi.stubEnv("TURNSTILE_DISABLED", "true");
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      const { auth } = await import("@/lib/auth");
      const plugin = (auth.options.plugins ?? []).find(
        (p) => (p as CaptchaPluginShape).id === "captcha"
      );
      expect(plugin).toBeUndefined();
    });

    // Fail safe. A deployment that asked for the captcha explicitly cannot lose
    // it by also carrying this variable.
    it("loses to TURNSTILE_ENFORCE", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CI", "");
      vi.stubEnv("TURNSTILE_ENFORCE", "true");
      vi.stubEnv("TURNSTILE_DISABLED", "true");
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      const { auth } = await import("@/lib/auth");
      const plugin = (auth.options.plugins ?? []).find(
        (p) => (p as CaptchaPluginShape).id === "captcha"
      ) as CaptchaPluginShape | undefined;
      expect(plugin).toBeDefined();
      expect(plugin?.options.endpoints).toEqual(["/sign-up/email"]);
    });

    // And still throws when enforce is on and the secret is missing, so the
    // opt-out cannot be used to dodge that assertion either.
    it("does not suppress the missing-secret throw under TURNSTILE_ENFORCE", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CI", "");
      vi.stubEnv("TURNSTILE_ENFORCE", "true");
      vi.stubEnv("TURNSTILE_DISABLED", "true");
      await expect(import("@/lib/auth")).rejects.toThrow(
        MISSING_CAPTCHA_SECRET_ERROR
      );
    });

    // Any value other than the exact string "true" is not an opt-out. Guards
    // that accept truthiness get switched off by accident.
    it("ignores values other than the literal true", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CI", "");
      vi.stubEnv("TURNSTILE_DISABLED", "1");
      await expect(import("@/lib/auth")).rejects.toThrow(
        MISSING_CAPTCHA_SECRET_ERROR
      );
    });
  });
});

describe("signup defenses: captcha load-test bypass", () => {
  const BYPASS_TOKEN = "load-test-captcha-bypass-token-32-bytes!";

  type CaptchaOnRequest = (
    request: Request,
    ctx: unknown
  ) => Promise<{ response?: Response } | undefined>;

  const ctxStub: unknown = {
    options: {},
    logger: { error: () => undefined },
  };

  function signupRequest(headers: Record<string, string>): Request {
    return new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers,
    });
  }

  async function loadCaptchaOnRequest(): Promise<CaptchaOnRequest | undefined> {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    ) as { onRequest?: CaptchaOnRequest } | undefined;
    return plugin?.onRequest;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  it("skips Turnstile on signup when a valid LOAD_TEST_BYPASS_TOKEN is presented", async () => {
    process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS_TOKEN;
    const onRequest = await loadCaptchaOnRequest();
    expect(onRequest).toBeDefined();
    const result = await onRequest?.(
      signupRequest({ "x-load-test-mfa-bypass": BYPASS_TOKEN }),
      ctxStub
    );
    expect(result).toBeUndefined();
  });

  it("enforces Turnstile on signup without the bypass header", async () => {
    process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS_TOKEN;
    const onRequest = await loadCaptchaOnRequest();
    // No bypass header and no x-captcha-response -> upstream rejects with a
    // 400 response rather than passing the request through.
    const result = await onRequest?.(signupRequest({}), ctxStub);
    expect(result?.response).toBeInstanceOf(Response);
  });

  it("enforces Turnstile when the bypass token does not match", async () => {
    process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS_TOKEN;
    const onRequest = await loadCaptchaOnRequest();
    const result = await onRequest?.(
      signupRequest({ "x-load-test-mfa-bypass": "not-the-real-token-value!!" }),
      ctxStub
    );
    expect(result?.response).toBeInstanceOf(Response);
  });

  it("does not bypass when LOAD_TEST_BYPASS_TOKEN is unset (production posture)", async () => {
    const onRequest = await loadCaptchaOnRequest();
    const result = await onRequest?.(
      signupRequest({ "x-load-test-mfa-bypass": BYPASS_TOKEN }),
      ctxStub
    );
    expect(result?.response).toBeInstanceOf(Response);
  });
});

describe("signup defenses: /sign-up/email rate limit rule", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  it("declares /sign-up/email before /* so first-match wins on signup", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { auth } = await import("@/lib/auth");
    const keys = Object.keys(auth.options.rateLimit?.customRules ?? {});
    const signupIdx = keys.indexOf("/sign-up/email");
    const wildcardIdx = keys.indexOf("/*");
    expect(signupIdx).toBeGreaterThanOrEqual(0);
    expect(wildcardIdx).toBeGreaterThanOrEqual(0);
    expect(signupIdx).toBeLessThan(wildcardIdx);
  });

  it("returns { window: 3600, max: 5 } for unauthenticated signup attempts", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { auth } = await import("@/lib/auth");
    const rule = auth.options.rateLimit?.customRules?.["/sign-up/email"] as
      | RateLimitRuleFn
      | undefined;
    expect(typeof rule).toBe("function");
    const req = new Request("http://localhost:3000/api/auth/sign-up/email");
    const resolved = await rule?.(req, { window: 60, max: 100 });
    expect(resolved).toEqual({ window: 3600, max: 5 });
  });

  it("returns false (bypass) when a valid X-Test-API-Key is presented", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
    process.env.TEST_API_KEY = TEST_API_KEY;
    const { auth } = await import("@/lib/auth");
    const rule = auth.options.rateLimit?.customRules?.["/sign-up/email"] as
      | RateLimitRuleFn
      | undefined;
    const req = new Request("http://localhost:3000/api/auth/sign-up/email", {
      headers: { "X-Test-API-Key": TEST_API_KEY },
    });
    const resolved = await rule?.(req, { window: 60, max: 100 });
    expect(resolved).toBe(false);
  });
});

describe("signup defenses: /sign-in/anonymous rate limit rule", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  it("declares /sign-in/anonymous before /* so first-match wins", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { auth } = await import("@/lib/auth");
    const keys = Object.keys(auth.options.rateLimit?.customRules ?? {});
    const anonIdx = keys.indexOf("/sign-in/anonymous");
    const wildcardIdx = keys.indexOf("/*");
    expect(anonIdx).toBeGreaterThanOrEqual(0);
    expect(wildcardIdx).toBeGreaterThanOrEqual(0);
    expect(anonIdx).toBeLessThan(wildcardIdx);
  });

  it("returns { window: 3600, max: 5 } for anonymous sign-in attempts", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { auth } = await import("@/lib/auth");
    const rule = auth.options.rateLimit?.customRules?.["/sign-in/anonymous"] as
      | RateLimitRuleFn
      | undefined;
    expect(typeof rule).toBe("function");
    const req = new Request("http://localhost:3000/api/auth/sign-in/anonymous");
    const resolved = await rule?.(req, { window: 60, max: 100 });
    expect(resolved).toEqual({ window: 3600, max: 5 });
  });

  it("returns false (bypass) when a valid X-Test-API-Key is presented", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
    process.env.TEST_API_KEY = TEST_API_KEY;
    const { auth } = await import("@/lib/auth");
    const rule = auth.options.rateLimit?.customRules?.["/sign-in/anonymous"] as
      | RateLimitRuleFn
      | undefined;
    const req = new Request(
      "http://localhost:3000/api/auth/sign-in/anonymous",
      { headers: { "X-Test-API-Key": TEST_API_KEY } }
    );
    const resolved = await rule?.(req, { window: 60, max: 100 });
    expect(resolved).toBe(false);
  });
});
