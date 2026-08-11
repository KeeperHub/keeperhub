import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

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

// Routes that should bypass the check (static assets, API routes, etc.)
const BYPASS_PREFIXES = ["/_next", "/api", "/favicon", "/_pagefind"];

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Bypass static assets and internal routes
  if (BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // Get the first path segment (top-level route)
  const segments = pathname.split("/").filter(Boolean);
  const topLevelRoute = segments[0]?.toLowerCase() || "";

  // Check if the top-level route is valid
  if (!VALID_ROUTES.has(topLevelRoute)) {
    // Return 404 for invalid routes without hitting the page component
    return NextResponse.rewrite(new URL("/404", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    "/((?!_next/static|_next/image|favicon.ico|llms.txt).*)",
  ],
};
