import Link from "next/link";
import { docsUrl, marketingUrl } from "@/lib/site/identity";

/**
 * Root 404.
 *
 * Two audiences. A person needs a way back; an agent needs to learn that the
 * path is genuinely absent (not gated, not temporarily broken) and where the
 * real index lives, so it stops guessing paths. The body is deliberately a
 * short link list rather than an illustration - the same content the markdown
 * representation carries, so both agree.
 *
 * The status code is Next.js's: rendering this component is what makes the
 * response a 404. It must never be reachable by a normal navigation.
 */
export default function NotFound(): React.ReactElement {
  const docs = docsUrl();
  const marketing = marketingUrl();
  const links: { label: string; href: string; description: string }[] = [
    // First, and in-app on purpose. notFound() is reachable from inside the
    // authenticated app - a bad execution id renders this page, and
    // /executions is in BARE_LAYOUT_PREFIXES, so the navigation sidebar is not
    // rendered at all for that route. Every other link here points off host,
    // which would leave a signed-in user with the browser back button as their
    // only way out.
    {
      label: "KeeperHub",
      href: "/",
      description: "Back to the app",
    },
    {
      label: "Sitemap",
      href: "/sitemap.xml",
      description: "Every crawlable public page",
    },
    {
      label: "llms.txt",
      href: `${docs}/llms.txt`,
      description: "Machine-readable index of the whole product",
    },
    {
      label: "Platform reference",
      href: `${docs}/platform-reference`,
      description: "API keys, MCP endpoint, chains, testnets, rate limits",
    },
    {
      label: "OpenAPI",
      href: "/openapi.json",
      description: "Callable endpoints and their schemas",
    },
    {
      label: "MCP server card",
      href: "/.well-known/mcp.json",
      description: "Tool catalog and transport",
    },
    {
      label: "Documentation",
      href: docs,
      description: "Concepts, plugins, API, CLI",
    },
    {
      label: "Contact",
      href: `${marketing}/contact`,
      description: "How to reach a human",
    },
  ];

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-background">
      <main className="mx-auto w-full max-w-2xl px-6 py-24">
        <h1 className="font-semibold text-3xl tracking-tight">
          404 - page not found
        </h1>
        <p className="mt-4 text-muted-foreground leading-relaxed">
          Nothing exists at this address. This is a real 404, not a gated page:
          the path does not exist and retrying it will not start working.
        </p>

        <h2 className="mt-12 font-semibold text-xl tracking-tight">
          Where to look next
        </h2>
        <ul className="mt-4 space-y-2 text-sm">
          {links.map((link) => (
            <li key={link.href}>
              {link.href.startsWith("/") ? (
                <Link
                  className="text-primary underline-offset-4 hover:underline"
                  href={link.href}
                >
                  {link.label}
                </Link>
              ) : (
                <a
                  className="text-primary underline-offset-4 hover:underline"
                  href={link.href}
                  rel="noopener"
                >
                  {link.label}
                </a>
              )}
              <span className="text-muted-foreground">
                {" — "}
                {link.description}
              </span>
            </li>
          ))}
        </ul>

        <h2 className="mt-12 font-semibold text-xl tracking-tight">
          If you expected a workflow here
        </h2>
        <p className="mt-4 text-muted-foreground leading-relaxed">
          Listed marketplace workflows are called at{" "}
          <code className="font-mono text-xs">
            POST /api/mcp/workflows/{"{slug}"}/call
          </code>
          . Enumerate the available slugs with{" "}
          <code className="font-mono text-xs">GET /api/mcp/workflows</code>{" "}
          rather than guessing a path.
        </p>
      </main>
    </div>
  );
}
