import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { readDeviceCookie } from "@/lib/device-cookie";
import { hasValidLoadTestBypass } from "@/lib/load-test-bypass";
import { checkWalletOrgMfaCompliance } from "@/lib/mfa/org-mfa-enforcement";
import {
  buildPendingIpSetCookie,
  encodePendingIpCookie,
} from "@/lib/pending-ip-cookie";
import { resolveSigninDevice } from "@/lib/security/device-trust";
import { gateRequestCountry } from "@/lib/security/login-risk";
import { negotiate } from "@/lib/site/accept";
import { NEGOTIABLE_PATHS, negotiablePage } from "@/lib/site/content";
import { renderPageMarkdown } from "@/lib/site/markdown";
import {
  hasSessionCookie,
  isTrustedOrigin,
  normaliseOrigin,
} from "@/lib/trusted-origins";

/**
 * Root request proxy. Four gates run in order on every matched request:
 *
 *  0. Markdown content negotiation: the public pages (/, /welcome, /about,
 *     /contact, /privacy, /pricing, /developers) are served as text/markdown
 *     when the client's Accept header prefers it, as text/html otherwise, and
 *     as 406 when it accepts neither. Both branches carry `Vary: Accept` so a
 *     CDN cannot serve one variant to a client that asked for the other. Runs
 *     first, ahead of the /welcome redirect, so an agent asking `/` for
 *     markdown is answered at the URL it asked about. See acceptmarkdown.com
 *     and RFC 9110 section 12.5.1.
 *
 *  1. CSRF defence: enforce Origin against trustedOrigins on state-
 *     changing /api/** requests that carry a better-auth session cookie.
 *     Layered with SameSite=Lax cookies to close sibling-subdomain CSRF.
 *     The cookie check is scoped to the better-auth session token, so
 *     Bearer/API-key callers behind Cloudflare Access (which sets
 *     `CF_AppSession` / `CF_Authorization`) are not false-positively
 *     blocked. See KEEP-240.
 *
 *  2. Mandatory-MFA gate: when an authenticated session is present,
 *     refuse to let the user reach anything except sign-out, auth
 *     callbacks, the enrollment endpoints, /enroll-mfa, and /verify-mfa
 *     until both:
 *       a. user.two_factor_enabled = true, and
 *       b. session.requires_mfa = false.
 *     Failing (a) yields 403 mfa_enrollment_required on API responses
 *     and 302 → /enroll-mfa on page navigation. Failing (b) yields 403
 *     mfa_pending and 302 → /verify-mfa.
 *
 *  3. Country trust gate: refuse to serve an authenticated request whose
 *     CF-attested country is not in the user's `user_trusted_countries`
 *     list. Page navigations get 302 → /verify-ip with a signed
 *     pending_ip_verify cookie; API calls get 403 ip_verification_required.
 *     The country list grows via sign-in events (first-attestation in
 *     session.create.before, or /verify-ip OTP confirmation). A legacy
 *     bridge honours a session whose IP is still in `user_trusted_ips`
 *     from before country trust shipped, backfilling the country so the
 *     transition is seamless. Requests with no CF country (local dev)
 *     pass through. New devices are warned about by email at sign-in, not
 *     here.
 *
 * Unauthenticated requests pass through untouched - route handlers
 * remain responsible for their own auth/authorization, and API-key
 * callers carry no session cookie so they bypass the gates by
 * construction.
 */

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const CSRF_EXEMPT_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/billing/webhooks/",
  "/api/cron/",
  "/api/oauth/",
];

const CSRF_EXEMPT_PATTERNS: readonly RegExp[] = [
  /^\/api\/workflows\/[^/]+\/webhook(?:\/|$)/,
  /^\/api\/mcp\/workflows\/[^/]+\/call(?:\/|$)/,
];

function isCsrfExemptPath(pathname: string): boolean {
  for (const prefix of CSRF_EXEMPT_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  for (const regex of CSRF_EXEMPT_PATTERNS) {
    if (regex.test(pathname)) {
      return true;
    }
  }
  return false;
}

function csrfBlock(request: NextRequest): NextResponse | null {
  const { method, nextUrl, headers } = request;

  if (!nextUrl.pathname.startsWith("/api/")) {
    return null;
  }
  if (!STATE_CHANGING_METHODS.has(method)) {
    return null;
  }
  if (isCsrfExemptPath(nextUrl.pathname)) {
    return null;
  }
  if (!hasSessionCookie(headers)) {
    return null;
  }

  const rawOrigin = headers.get("origin") ?? headers.get("referer");
  const origin = normaliseOrigin(rawOrigin);

  if (!origin) {
    console.info("[csrf] blocked: missing origin", {
      method,
      path: nextUrl.pathname,
    });
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  if (!isTrustedOrigin(origin)) {
    console.info("[csrf] blocked: untrusted origin", {
      method,
      path: nextUrl.pathname,
      origin,
    });
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  return null;
}

// ---------------------------------------------------------------------------
// MFA gate
// ---------------------------------------------------------------------------

/**
 * API path prefixes that a locked session must still reach. Better Auth's
 * catch-all covers sign-in / sign-out / two-factor verify / OAuth callbacks;
 * the totp/* endpoints are needed for the enrollment + step-up flows; the
 * forgot-password endpoint is anonymous; the OG endpoint is public; health,
 * cron, and MCP schemas have no session-bearer browser caller.
 */
const MFA_EXEMPT_API_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/user/totp/",
  // The wallet enforce-mfa enrollment flow adds a verified email here; without
  // this the gate would block the very call needed to satisfy it (a lockout).
  "/api/user/step-up/email",
  "/api/user/verify-ip",
  "/api/user/forgot-password",
  "/api/og/",
  "/api/health",
  "/api/mcp/schemas",
  "/api/cron/",
];

/**
 * Marketing / standalone page routes plus the gate pages themselves.
 * `/` is intentionally NOT in this set: signed-out visitors land
 * there and `hasSessionCookie` short-circuits the gate for them, but
 * signed-in users on `/` must still be routed through enrollment /
 * step-up before any other navigation.
 *
 * Every entry must name a route that exists. Four did not: /pricing, /about,
 * /terms and /privacy sat here naming pages this app has never served. That is
 * not harmless - the list reads as the inventory of public pages, so a dangling
 * entry makes a page look shipped when it 404s. Those pages live on
 * keeperhub.com. If any is ever served from this host, add the path back here
 * and to PUBLIC_PAGE_PATHS in lib/site/content.ts together.
 */
const MFA_EXEMPT_PAGES = new Set<string>([
  "/welcome",
  "/enroll-mfa",
  "/enforce-mfa",
  "/verify-mfa",
  "/verify-ip",
]);

const MFA_EXEMPT_PAGE_PREFIXES: readonly string[] = [
  "/docs",
  "/sign-in",
  "/sign-up",
];

function isMfaExemptPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) {
    for (const prefix of MFA_EXEMPT_API_PREFIXES) {
      if (pathname.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
  if (MFA_EXEMPT_PAGES.has(pathname)) {
    return true;
  }
  for (const prefix of MFA_EXEMPT_PAGE_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function mfaApiError(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

function mfaRedirect(
  request: NextRequest,
  target: string,
  reason: string
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = target;
  url.search = "";
  url.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search
  );
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

type GatedUser = { id: string; email: string };

type MfaResult =
  | { kind: "block"; response: NextResponse }
  | { kind: "pass"; user: GatedUser | null };

async function mfaBlock(request: NextRequest): Promise<MfaResult> {
  const { pathname } = request.nextUrl;

  if (isMfaExemptPath(pathname)) {
    return { kind: "pass", user: null };
  }
  if (hasValidLoadTestBypass(request)) {
    return { kind: "pass", user: null };
  }
  // No session cookie at all → no session → nothing to gate on. Route
  // handlers + public pages serve themselves; API-key callers skip the
  // gate naturally because they don't carry the session cookie.
  if (!hasSessionCookie(request.headers)) {
    return { kind: "pass", user: null };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { kind: "pass", user: null };
  }

  // Anonymous sessions have no permanent identity to protect, so gating
  // them on MFA is incoherent. Let them through so landing-page visitors
  // can build a workflow before signing up. Key off the authoritative
  // is_anonymous column only - the name/email heuristics in
  // auth-anonymous-guard are user-controllable (name is editable via
  // /api/user), and using them here would let a real user bypass the gate
  // by renaming themselves "Anonymous".
  if ((session.user as { isAnonymous?: boolean | null }).isAnonymous === true) {
    return { kind: "pass", user: null };
  }

  // Wallet (SIWE) users authenticate by signing a nonce, which is itself a
  // possession factor. There is no email channel to send an OTP to and no
  // TOTP enrollment forced on them, so the global mandatory-MFA gate is
  // incoherent here. They are MFA-exempt by default - EXCEPT when their active
  // org's owner has switched on MFA enforcement. In that case the wallet user
  // must carry one of the org's required factors (TOTP and/or a verified
  // email); if not, hard-gate them to /enforce-mfa until they enroll. Outside
  // an enforcing org they pass through like anonymous sessions (user: null
  // also skips the country gate).
  const apiPath = pathname.startsWith("/api/");

  if (isWalletEmail((session.user as { email?: string | null }).email)) {
    const activeOrgId = (
      session.session as { activeOrganizationId?: string | null }
    ).activeOrganizationId;
    const compliance = await checkWalletOrgMfaCompliance({
      userId: session.user.id,
      activeOrganizationId: activeOrgId,
    });
    if (compliance.compliant) {
      return { kind: "pass", user: null };
    }
    if (apiPath) {
      return {
        kind: "block",
        response: mfaApiError(
          403,
          "org_mfa_enrollment_required",
          "Your organization requires two-factor authentication. Add a second factor to continue."
        ),
      };
    }
    return {
      kind: "block",
      response: mfaRedirect(request, "/enforce-mfa", "enroll"),
    };
  }

  const user = session.user as {
    twoFactorEnabled?: boolean | null;
    email?: string | null;
  };
  const sess = session.session as { requiresMfa?: boolean | null };

  if (user.twoFactorEnabled !== true) {
    if (apiPath) {
      return {
        kind: "block",
        response: mfaApiError(
          403,
          "mfa_enrollment_required",
          "Enable two-factor authentication on your account before continuing."
        ),
      };
    }
    return {
      kind: "block",
      response: mfaRedirect(request, "/enroll-mfa", "enroll"),
    };
  }

  if (sess.requiresMfa === true) {
    if (apiPath) {
      return {
        kind: "block",
        response: mfaApiError(
          403,
          "mfa_pending",
          "Verify your second factor to continue."
        ),
      };
    }
    return {
      kind: "block",
      response: mfaRedirect(request, "/verify-mfa", "verify"),
    };
  }

  if (!user.email) {
    return { kind: "pass", user: null };
  }

  return { kind: "pass", user: { id: session.user.id, email: user.email } };
}

// ---------------------------------------------------------------------------
// Country gate
// ---------------------------------------------------------------------------

async function countryGateBlock(
  request: NextRequest,
  user: GatedUser
): Promise<NextResponse | null> {
  // The exempt set already lets /verify-ip, /api/user/verify-ip,
  // /api/auth/*, and the marketing pages through. Reusing it here keeps
  // the two gates from contradicting each other.
  if (isMfaExemptPath(request.nextUrl.pathname)) {
    return null;
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    // No secret means we can't sign the pending cookie, and a fail-closed
    // 500 here would lock the whole app out. Fail open: the gate is a
    // defence-in-depth layer on top of MFA, and the operator alerting on
    // the missing secret is the right corrective signal.
    return null;
  }

  const gate = await gateRequestCountry(user.id);
  if (gate.kind === "trusted" || gate.kind === "no_country") {
    // Adopt the browser as a known device when a passing request carries no
    // device cookie -- sessions minted before device tracking shipped. Gated
    // to top-level document navigations so the ~20-request fan-out of a page
    // load (API + RSC subrequests) doesn't each mint a distinct device id;
    // one navigation sets the cookie and the rest carry it. Silent
    // (notifyOnNew: false) so an already-active session is not emailed.
    const isDocumentNav = request.headers.get("sec-fetch-dest") === "document";
    if (isDocumentNav && !readDeviceCookie(request.headers)) {
      const deviceSetCookie = await resolveSigninDevice({
        userId: user.id,
        email: user.email,
        country: null,
        request,
        notifyOnNew: false,
      });
      if (deviceSetCookie) {
        const passthrough = NextResponse.next();
        passthrough.headers.append("set-cookie", deviceSetCookie);
        return passthrough;
      }
    }
    return null;
  }

  // An untrusted CF country always carries a CF-Connecting-IP, so gate.ip is
  // non-null here. Without an IP the /verify-ip replay can't be pinned, so
  // pass rather than issue an unbindable verify cookie.
  if (!gate.ip) {
    return null;
  }

  const apiPath = request.nextUrl.pathname.startsWith("/api/");
  if (apiPath) {
    return NextResponse.json(
      {
        error: "Verify your sign-in in your browser to continue.",
        code: "ip_verification_required",
      },
      { status: 403 }
    );
  }

  const cookieValue = encodePendingIpCookie(
    {
      userId: user.id,
      email: user.email,
      ip: gate.ip,
      country: gate.country,
      redirect: request.nextUrl.pathname + request.nextUrl.search,
    },
    secret
  );
  const target = request.nextUrl.clone();
  target.pathname = "/verify-ip";
  target.search = "";
  target.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search
  );
  const response = NextResponse.redirect(target);
  response.headers.append("Set-Cookie", buildPendingIpSetCookie(cookieValue));
  return response;
}

// ---------------------------------------------------------------------------
// Markdown content negotiation
// ---------------------------------------------------------------------------

/**
 * Serves the markdown representation of a public page when the client asks for
 * one, per acceptmarkdown.com (and RFC 9110 section 12.5.1 underneath it).
 *
 * Runs before every other gate, including the /welcome redirect, so an agent
 * that asks `/` for markdown gets the answer at the URL it asked about instead
 * of a 307 into a sign-in page. The gates it skips are all about protecting an
 * authenticated session; these six pages are public documents that render the
 * same bytes for everyone, so there is nothing here for them to protect.
 *
 * `Vary: Accept` goes on every response this gate returns itself - the markdown
 * body, the 406, and the `/` -> `/welcome` redirect - because those are the
 * cacheable half of the negotiation (markdown is served `public, max-age=300`).
 *
 * It cannot be put on the rendered HTML variant from here, or from
 * next.config.ts `headers()`, or anywhere else in userland: Next.js computes its
 * own `Vary` for RSC routing during the render and overwrites whatever was set
 * beforehand. That is survivable rather than a hole, because those HTML
 * responses ship `private, no-cache, no-store, must-revalidate` (Cloudflare
 * records them as cf-cache-status: DYNAMIC), so no shared cache holds a variant
 * to hand to the wrong client. If those pages ever become cacheable, the fix is
 * an edge transform rule appending `Accept` to `Vary` on these paths, since the
 * framework will still overwrite anything set in the app.
 */

/** Headers Next.js adds to its own RSC fetches. Never content negotiation. */
const RSC_REQUEST_HEADERS: readonly string[] = [
  "rsc",
  "next-router-prefetch",
  "next-router-state-tree",
  "next-router-segment-prefetch",
];

const VARY_ACCEPT = "Accept, Accept-Encoding";

function isRscRequest(request: NextRequest): boolean {
  for (const header of RSC_REQUEST_HEADERS) {
    if (request.headers.has(header)) {
      return true;
    }
  }
  return false;
}

function isNegotiablePath(pathname: string): boolean {
  return NEGOTIABLE_PATHS.includes(pathname);
}

function markdownNegotiation(request: NextRequest): NextResponse | null {
  const { method } = request;
  if (method !== "GET" && method !== "HEAD") {
    return null;
  }
  const { pathname } = request.nextUrl;
  if (!isNegotiablePath(pathname) || isRscRequest(request)) {
    return null;
  }

  const decision = negotiate(request.headers.get("accept"));

  if (decision.kind === "html") {
    // Fall through to the normal HTML pipeline, but mark the response as
    // negotiated so caches key on Accept.
    return null;
  }

  if (decision.kind === "not-acceptable") {
    const body =
      "406 Not Acceptable. This URL is available as text/html and text/markdown.\n";
    return new NextResponse(method === "HEAD" ? null : body, {
      status: 406,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Vary: VARY_ACCEPT,
      },
    });
  }

  const page = negotiablePage(pathname);
  if (!page) {
    // NEGOTIABLE_PATHS and the page map are built from the same module, so this
    // is unreachable; falling through to HTML is the safe way to be wrong.
    return null;
  }

  const markdown = renderPageMarkdown(page);
  return new NextResponse(method === "HEAD" ? null : markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Language": "en",
      Vary: VARY_ACCEPT,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      Link: `<${request.nextUrl.origin}${page.path}>; rel="canonical"`,
    },
  });
}

/**
 * Marks a proxy-returned response as varying on Accept.
 *
 * Only reaches the wire on responses the proxy returns itself; on a
 * `NextResponse.next()` that goes on to render a page, the renderer replaces
 * `Vary` (see the note above). Applied to both anyway so the intent travels
 * with the code rather than living in a comment.
 */
function applyVaryAccept(
  request: NextRequest,
  response: NextResponse
): NextResponse {
  if (!isNegotiablePath(request.nextUrl.pathname)) {
    return response;
  }
  response.headers.append("Vary", VARY_ACCEPT);
  return response;
}

// ---------------------------------------------------------------------------
// Composed proxy entry point
// ---------------------------------------------------------------------------

/**
 * A signed-out visitor (no session cookie) hitting the app entry is sent
 * straight to the welcome landing, so we never render "/" only to redirect
 * client-side. Cookie-bearing users (anonymous or real) fall through to the
 * client gate, which knows about the guest and onboarding flags.
 */
function welcomeRedirect(request: NextRequest): NextResponse | null {
  if (request.method !== "GET" || request.nextUrl.pathname !== "/") {
    return null;
  }
  if (hasSessionCookie(request.headers)) {
    return null;
  }
  const url = request.nextUrl.clone();
  url.pathname = "/welcome";
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const markdown = markdownNegotiation(request);
  if (markdown) {
    return markdown;
  }
  const welcome = welcomeRedirect(request);
  if (welcome) {
    return applyVaryAccept(request, welcome);
  }
  const csrfResponse = csrfBlock(request);
  if (csrfResponse) {
    return csrfResponse;
  }
  const mfaResult = await mfaBlock(request);
  if (mfaResult.kind === "block") {
    return mfaResult.response;
  }
  if (mfaResult.user) {
    const countryResponse = await countryGateBlock(request, mfaResult.user);
    if (countryResponse) {
      return countryResponse;
    }
  }
  return applyVaryAccept(request, NextResponse.next());
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *   - _next/static, _next/image  (build artefacts)
     *   - favicon.ico, robots.txt, sitemap.xml (root static files)
     *   - public/*  (anything mounted from public/)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|public/).*)",
  ],
};
