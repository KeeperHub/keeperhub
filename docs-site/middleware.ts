import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { negotiate } from "./lib/accept";

// Valid top-level routes from the docs content. Must list every top-level entry
// in content/_meta.ts plus every top-level .md file; anything missing here 404s
// before the page component runs. Legacy slugs (quickstart, intro, ai-tools) are
// absent on purpose: next.config.mjs redirects run before middleware, so those
// requests never reach this check.
const VALID_ROUTES = new Set([
  "",
  "faq",
  "agent",
  "api",
  "cli",
  "concepts",
  "getting-started",
  "keeper-runs",
  "keepers",
  "notifications",
  "platform-reference",
  "plugins",
  "practices",
  "users-teams-orgs",
  "wallet-management",
  "workflows",
  "guides",
]);

// Prefixes that are not docs pages at all: build output and the emitted
// Markdown tree. These skip both the route check and content negotiation --
// negotiating on a JS chunk or a font would be meaningless.
//
// "/api" used to be listed here as an "API route" bypass, but docs-site has no
// route handlers (find docs-site/app -name 'route.*' is empty) and "api" is a
// top-level entry in VALID_ROUTES above, so the bypass was redundant for its
// stated purpose. It was not harmless: it returned early for the whole /api
// docs section, which is the largest one, so those pages silently skipped
// Markdown negotiation and their .md alternates 404'd.
const BYPASS_PREFIXES = ["/_next", "/favicon", "/_pagefind", "/_md"];

// ---------------------------------------------------------------------------
// Markdown content negotiation
// ---------------------------------------------------------------------------

/**
 * Every docs page is also served as Markdown, per acceptmarkdown.com and
 * RFC 9110 section 12.5.1. Two ways to ask for it, both landing on the same
 * file that scripts/emit-markdown.mjs wrote into public/_md/ at build time:
 *
 *   GET /api/authentication      with `Accept: text/markdown`
 *   GET /api/authentication.md   explicitly, no negotiation needed
 *
 * Docs is the host agents most want to read, and its source is already
 * Markdown - rendering it to HTML and asking an agent to parse it back is pure
 * loss. The rewrite is internal, so the negotiated response is returned at the
 * URL the caller asked about rather than redirecting them somewhere else.
 */
const MARKDOWN_PREFIX = "/_md";
const MARKDOWN_SUFFIX = ".md";
const VARY_ACCEPT = "Accept, Accept-Encoding";

/** Headers Next.js adds to its own RSC fetches. Never content negotiation. */
const RSC_REQUEST_HEADERS = [
  "rsc",
  "next-router-prefetch",
  "next-router-state-tree",
  "next-router-segment-prefetch",
];

function isRscRequest(request: NextRequest): boolean {
  return RSC_REQUEST_HEADERS.some((header) => request.headers.has(header));
}

/** The emitted file for a route. "/" has no bare name, so it keeps index.md. */
function markdownTarget(pathname: string): string {
  const trimmed = pathname.replace(/\/$/, "");
  return trimmed === ""
    ? `${MARKDOWN_PREFIX}/index${MARKDOWN_SUFFIX}`
    : `${MARKDOWN_PREFIX}${trimmed}${MARKDOWN_SUFFIX}`;
}

function withVary(response: NextResponse): NextResponse {
  response.headers.set("Vary", VARY_ACCEPT);
  return response;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Bypass static assets and internal routes
  if (BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // The explicit alternate: /api/authentication.md -> the emitted file. Handled
  // before the route check because ".md" is not a route segment. Method-agnostic
  // on purpose: it is a static file, and HEAD on it should answer like GET.
  if (pathname.endsWith(MARKDOWN_SUFFIX)) {
    const target = `${MARKDOWN_PREFIX}${pathname}`;
    return withVary(NextResponse.rewrite(new URL(target, request.url)));
  }

  // Get the first path segment (top-level route)
  const segments = pathname.split("/").filter(Boolean);
  const topLevelRoute = segments[0]?.toLowerCase() || "";

  // Check if the top-level route is valid
  if (!VALID_ROUTES.has(topLevelRoute)) {
    // Return 404 for invalid routes without hitting the page component
    return NextResponse.rewrite(new URL("/404", request.url));
  }

  // Negotiated Markdown. GET and HEAD together, matching proxy.ts in the app:
  // gating on GET alone meant `HEAD /concepts` answered with HTML headers while
  // `GET /concepts` with the same Accept answered with Markdown, so a client
  // probing with HEAD before fetching got the wrong content type. Excludes RSC
  // navigations, which carry a permissive Accept and would break client-side
  // routing if answered with Markdown.
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    !isRscRequest(request)
  ) {
    const decision = negotiate(request.headers.get("accept"));
    if (decision.kind === "markdown") {
      return withVary(
        NextResponse.rewrite(new URL(markdownTarget(pathname), request.url))
      );
    }
    if (decision.kind === "not-acceptable") {
      return withVary(
        new NextResponse(
          "406 Not Acceptable. This URL is available as text/html and text/markdown.\n",
          {
            status: 406,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        )
      );
    }
  }

  return withVary(NextResponse.next());
}

export const config = {
  matcher: [
    // Match all paths except static files and the metadata routes.
    //
    // robots.txt and sitemap.xml have to be excluded here, alongside llms.txt:
    // they are generated by app/robots.ts and app/sitemap.ts, but their first
    // path segment ("robots.txt", "sitemap.xml") is not in VALID_ROUTES, so
    // without this the route check rewrites both to /404 and the site serves
    // its 404 page in place of them.
    "/((?!_next/static|_next/image|favicon.ico|llms.txt|robots.txt|sitemap.xml).*)",
  ],
};
