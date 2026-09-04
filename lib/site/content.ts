/**
 * The homepage's public content, as data.
 *
 * One structure feeds three consumers: the server-rendered footer on /welcome
 * (components/site/site-footer.tsx), the markdown representation served when a
 * client negotiates `text/markdown` (lib/site/markdown.ts), and the sitemap.
 * Keeping them off a single source would guarantee the HTML and the markdown
 * drift, which is exactly the failure mode `Vary: Accept` exists to prevent.
 *
 * This briefly held /about, /contact, /privacy, /pricing and /developers too.
 * They were removed rather than moved here from somewhere - the first three
 * duplicated live pages on keeperhub.com, with both copies self-canonical and
 * both in sitemaps, which splits ranking signals between two hosts for one
 * page. /developers restated docs/platform-reference.md and docs/api/errors.md
 * in TypeScript prose without deriving any of it from code, so it was a second
 * copy of the docs that could go stale independently.
 *
 * What is left is the material that can only be true of this host: what the
 * product is, and where its machine-readable surfaces live.
 */

import { appUrl, docsUrl, marketingUrl } from "@/lib/site/identity";

export type SiteLink = {
  label: string;
  href: string;
  description?: string;
};

export type SiteTable = {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
};

export type SiteSection = {
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  links?: readonly SiteLink[];
  table?: SiteTable;
  code?: { language: string; source: string };
};

export type SitePage = {
  /** Route path, also the key used by the markdown negotiator. */
  path: string;
  /** <title> and markdown front-matter title. */
  title: string;
  /** The single <h1>. */
  heading: string;
  /** Meta description and the lead paragraph. */
  description: string;
  sections: readonly SiteSection[];
  /** Sitemap priority; omitted pages default to 0.5. */
  priority?: number;
};

const PRODUCT_SUMMARY =
  "KeeperHub is a Web3 workflow automation platform. Teams and AI agents build, schedule, and run onchain workflows - smart contract monitoring, token transfers, DeFi operations, multi-channel notifications - through a visual builder, a REST API, a command-line tool, or a hosted Model Context Protocol server.";

const WORKFLOW_MODEL =
  "A workflow is a directed graph of nodes. A node is either a trigger (Manual, Schedule, Webhook, Event, Block) or an action supplied by a plugin. Nodes connect through edges with named source handles, and runtime values flow between them using the template syntax {{@nodeId:Label.field}}. One run of a workflow is an execution, tracked with status, logs, and metrics.";

function homePage(): SitePage {
  const app = appUrl();
  const docs = docsUrl();
  const marketing = marketingUrl();
  return {
    path: "/",
    title: "KeeperHub - Blockchain Workflow Automation",
    heading: "KeeperHub - blockchain workflow automation",
    description: PRODUCT_SUMMARY,
    priority: 1,
    sections: [
      {
        heading: "What KeeperHub does",
        paragraphs: [
          WORKFLOW_MODEL,
          "Write operations sign through an organization wallet whose private key is generated and held inside a hardware enclave, and every run is recorded with its inputs, outputs, transaction hashes, and gas usage. Organizations set spending limits and gas sponsorship policy, so an automated caller cannot exceed the budget its owners approved.",
        ],
      },
      {
        heading: "Programmatic access",
        paragraphs: [
          "Every capability in the visual builder is reachable without a browser. Agents can discover the surface from machine-readable documents and call it with an organization API key or an OAuth access token.",
        ],
        links: [
          {
            label: "Developer reference",
            href: `${docs}/platform-reference`,
            description:
              "API keys, MCP endpoint, chains, testnets, rate limits",
          },
          {
            label: "OpenAPI specification",
            href: "/openapi.json",
            description: "Machine-readable schema for the callable endpoints",
          },
          {
            label: "MCP server",
            href: "/mcp",
            description: "OAuth-authenticated Model Context Protocol endpoint",
          },
          {
            label: "MCP server card",
            href: "/.well-known/mcp.json",
            description: "Transport, tool catalog, and authentication metadata",
          },
          {
            label: "Documentation",
            href: docs,
            description: "Concepts, plugins, API, CLI, and agent guides",
          },
          {
            label: "llms.txt",
            href: `${docs}/llms.txt`,
            description: "Canonical site map for language models",
          },
        ],
      },
      {
        heading: "Company",
        // Off-host on purpose. These pages live on the marketing site, and a
        // second copy here would compete with them for the same query.
        links: [
          { label: "KeeperHub", href: marketing },
          { label: "Pricing", href: `${marketing}/pricing` },
          { label: "Contact", href: `${marketing}/contact` },
          { label: "Privacy", href: `${marketing}/privacy` },
          { label: "Error reference", href: `${docs}/api/errors` },
          { label: "Sitemap", href: `${app}/sitemap.xml` },
        ],
      },
    ],
  };
}

/**
 * Every public page, keyed by path. Built per call rather than frozen at module
 * load so a deployment's environment (app URL, docs URL, contact addresses) is
 * read at request time, matching how lib/agent-identity.ts behaves.
 */
export function publicPages(): Record<string, SitePage> {
  const pages = [homePage()];
  const byPath: Record<string, SitePage> = {};
  for (const page of pages) {
    byPath[page.path] = page;
  }
  return byPath;
}

export function publicPage(path: string): SitePage | null {
  return publicPages()[path] ?? null;
}

/**
 * Pages backed by a SitePage.
 *
 * Only the homepage. /about, /contact, /privacy, /pricing and /developers lived
 * here briefly and were removed: the first three duplicated live pages on
 * keeperhub.com (both self-canonical, both in sitemaps - textbook cross-host
 * duplicate content), and /developers restated docs/platform-reference.md and
 * docs/api/errors.md in TypeScript prose. Developer material belongs on
 * docs.keeperhub.com, which now negotiates markdown and has its own sitemap.
 */
export const PUBLIC_PAGE_PATHS: readonly string[] = ["/"];

/**
 * Paths that participate in Accept negotiation. `/welcome` is included because
 * it is where `/` sends a signed-out visitor, so an agent that follows the
 * redirect and then asks for markdown must get the same answer as one that
 * asked at `/`.
 */
export const NEGOTIABLE_PATHS: readonly string[] = [
  ...PUBLIC_PAGE_PATHS,
  "/welcome",
];

/** The SitePage a negotiable path resolves to. */
export function negotiablePage(path: string): SitePage | null {
  return publicPage(path === "/welcome" ? "/" : path);
}
