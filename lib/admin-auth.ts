import crypto from "node:crypto";

export type AdminAuthResult = {
  authenticated: boolean;
  error?: string;
};

function secureCompare(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Returns true iff admin test endpoints and their companion rate-limit
// bypass should be available. Requires BOTH:
//   1. Build-time: INCLUDE_TEST_ENDPOINTS baked into the bundle by
//      next.config.ts env config (so runtime env cannot flip it).
//   2. Runtime: in production, explicit ALLOW_TEST_ENDPOINTS=true opt-in.
// See KEEP-237.
export function testEndpointsEnabled(): boolean {
  if (process.env.INCLUDE_TEST_ENDPOINTS !== "true") {
    return false;
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_TEST_ENDPOINTS !== "true"
  ) {
    return false;
  }
  return true;
}

export function authenticateAdmin(request: Request): AdminAuthResult {
  if (!testEndpointsEnabled()) {
    return {
      authenticated: false,
      error: "Admin test endpoints disabled in production",
    };
  }

  const adminKey = process.env.TEST_API_KEY;
  if (!adminKey) {
    return { authenticated: false, error: "Admin API not configured" };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      authenticated: false,
      error: "Missing or invalid Authorization header",
    };
  }

  const token = authHeader.slice(7);
  if (!secureCompare(token, adminKey)) {
    return { authenticated: false, error: "Invalid admin API key" };
  }

  return { authenticated: true };
}

export function validateTestEmail(email: string): string | null {
  if (!email?.endsWith("@techops.services")) {
    return "Email must end with @techops.services";
  }
  return null;
}

type RateLimitRule = { window: number; max: number };

// better-auth rateLimit.customRules["/*"] handler. Disables rate limiting
// when the request carries a valid X-Test-API-Key header AND test endpoints
// are enabled (build-time + runtime gates via testEndpointsEnabled). Returns
// the default rule otherwise. Extracted from lib/auth.ts for unit testing.
export function rateLimitBypassRule(
  req: Request,
  currentRule: RateLimitRule
): RateLimitRule | false {
  if (!testEndpointsEnabled()) {
    return currentRule;
  }
  const testApiKey = process.env.TEST_API_KEY;
  if (!testApiKey) {
    return currentRule;
  }
  const authHeader = req.headers.get("X-Test-API-Key");
  if (authHeader && authHeader === testApiKey) {
    return false;
  }
  return currentRule;
}
