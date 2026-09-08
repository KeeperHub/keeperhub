import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the database BEFORE importing the modules that consume it. The
// metadata routes import `db` from "@/lib/db"; the sitemap route is the
// only one that runs SQL — robots is a static config.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

// We re-import the mocked `db` to control what `select().from()` returns.
import { db } from "@/lib/db";

describe("app/robots.ts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("default-exports a function returning a MetadataRoute.Robots shape", async () => {
    const robotsModule = await import("@/app/robots");
    expect(typeof robotsModule.default).toBe("function");
    const result = robotsModule.default();
    expect(result).toHaveProperty("rules");
    expect(result).toHaveProperty("sitemap");
  });

  it("disallows /hub? query-string variants and /marketplace? query-string variants (HUB-13)", async () => {
    const robotsModule = await import("@/app/robots");
    const result = robotsModule.default();
    const firstRule = Array.isArray(result.rules)
      ? result.rules[0]
      : result.rules;
    const disallow = Array.isArray(firstRule.disallow)
      ? firstRule.disallow
      : [firstRule.disallow];
    expect(disallow).toContain("/hub?");
    expect(disallow).toContain("/marketplace?");
  });

  it("allows /hub, /hub/tags/, and /marketplace canonical paths", async () => {
    const robotsModule = await import("@/app/robots");
    const result = robotsModule.default();
    const firstRule = Array.isArray(result.rules)
      ? result.rules[0]
      : result.rules;
    const allow = Array.isArray(firstRule.allow)
      ? firstRule.allow
      : [firstRule.allow];
    expect(allow).toContain("/hub");
    expect(allow).toContain("/hub/tags/");
    expect(allow).toContain("/marketplace");
  });

  it("emits a bare hostname in the Host directive", async () => {
    // Host is not a URL. With a scheme the line is discarded by crawlers, so
    // it looked configured while doing nothing.
    const robotsModule = await import("@/app/robots");
    const { host } = robotsModule.default();
    expect(host).toBe("app.keeperhub.com");
    expect(host).not.toMatch(/^https?:\/\//);
  });

  it("points to a sitemap URL on the configured base URL", async () => {
    const robotsModule = await import("@/app/robots");
    const result = robotsModule.default();
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
  });

  it("names every AI agent crawler with the same allow list as `*` (agent readiness)", async () => {
    const { AGENT_CRAWLER_USER_AGENTS } = await import("@/lib/site/crawlers");
    const robotsModule = await import("@/app/robots");
    const rules = robotsModule.default().rules;
    const list = Array.isArray(rules) ? rules : [rules];

    const wildcard = list.find((rule) => rule.userAgent === "*");
    expect(wildcard).toBeDefined();

    // A crawler named here but given a narrower allow list than `*` would be
    // worse than not naming it: it reads as a deliberate restriction.
    for (const agent of AGENT_CRAWLER_USER_AGENTS) {
      const rule = list.find((entry) => entry.userAgent === agent);
      expect(rule, `missing robots rule for ${agent}`).toBeDefined();
      expect(rule?.allow).toEqual(wildcard?.allow);
      expect(rule?.disallow).toEqual(wildcard?.disallow);
    }
  });

  it("covers the crawlers the readiness audit probes", async () => {
    const { AGENT_CRAWLER_USER_AGENTS } = await import("@/lib/site/crawlers");
    for (const agent of [
      "GPTBot",
      "ChatGPT-User",
      "ClaudeBot",
      "PerplexityBot",
      "Google-Extended",
      "DeepSeekBot",
      "ora-agent",
    ]) {
      expect(AGENT_CRAWLER_USER_AGENTS).toContain(agent);
    }
  });

  it("does not invite crawlers the edge blocks everywhere", async () => {
    // robots.txt and the Cloudflare rule are one policy expressed twice. A UA
    // invited here and 403'd at the edge is worse than either alone: the
    // crawler retries, and a readiness audit reads the 403 as "unreachable".
    // See prod/keeperhub-infrastructure/cloudflare.tf in the infra repo.
    const { AGENT_CRAWLER_USER_AGENTS } = await import("@/lib/site/crawlers");
    for (const blocked of [
      "Bytespider",
      "Meta-ExternalAgent",
      "cohere-training-data-crawler",
      "cohere-ai",
    ]) {
      expect(AGENT_CRAWLER_USER_AGENTS).not.toContain(blocked);
    }
    // Meta-ExternalFetcher (user-initiated) is allowed; Meta-ExternalAgent
    // (bulk crawl) is not. Different agents, one character apart in practice.
    expect(AGENT_CRAWLER_USER_AGENTS).toContain("Meta-ExternalFetcher");
  });

  it("allows the machine-readable documents despite the /api/ disallow", async () => {
    const robotsModule = await import("@/app/robots");
    const rules = robotsModule.default().rules;
    const firstRule = Array.isArray(rules) ? rules[0] : rules;
    const allow = Array.isArray(firstRule.allow)
      ? firstRule.allow
      : [firstRule.allow];
    // robots.txt precedence is longest-match, so the more specific allow wins
    // over the "/api/" disallow.
    expect(allow).toContain("/api/openapi");
    expect(allow).toContain("/openapi.json");
    expect(allow).toContain("/.well-known/");
  });

  it("does not advertise app-side copies of the marketing pages", async () => {
    // They live on keeperhub.com. Allowing a duplicate here would invite a
    // crawler to index two self-canonical copies of one page.
    const robotsModule = await import("@/app/robots");
    const rules = robotsModule.default().rules;
    const firstRule = Array.isArray(rules) ? rules[0] : rules;
    const allow = Array.isArray(firstRule.allow)
      ? firstRule.allow
      : [firstRule.allow];
    for (const path of [
      "/about",
      "/contact",
      "/privacy",
      "/pricing",
      "/developers",
    ]) {
      expect(allow).not.toContain(path);
    }
    expect(allow).toContain("/welcome");
  });
});

describe("app/sitemap.ts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("default-exports an async function", async () => {
    // Make db.select() resolve to an empty list so the function returns.
    (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    });
    const sitemapModule = await import("@/app/sitemap");
    expect(typeof sitemapModule.default).toBe("function");
    const result = await sitemapModule.default();
    expect(Array.isArray(result)).toBe(true);
  });

  it("includes /hub static entry and one /hub/tags/{slug} entry per public tag", async () => {
    const fakeTags = [
      { slug: "defi", createdAt: new Date("2026-01-01T00:00:00Z") },
      { slug: "monitoring", createdAt: new Date("2026-02-01T00:00:00Z") },
    ];
    (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockResolvedValue(fakeTags),
    });

    const sitemapModule = await import("@/app/sitemap");
    const result = await sitemapModule.default();

    const urls: string[] = result.map((entry: { url: string }) => entry.url);
    expect(urls.some((u) => u.endsWith("/hub"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/hub/tags/defi"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/hub/tags/monitoring"))).toBe(true);
  });

  it("queries publicTags table via db.select().from()", async () => {
    (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    });
    const sitemapModule = await import("@/app/sitemap");
    await sitemapModule.default();
    expect(db.select).toHaveBeenCalled();
  });

  it("lists every public page from lib/site/content.ts", async () => {
    (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    });
    const { PUBLIC_PAGE_PATHS } = await import("@/lib/site/content");
    const sitemapModule = await import("@/app/sitemap");
    const result = await sitemapModule.default();
    const urls: string[] = result.map((entry: { url: string }) => entry.url);

    for (const path of PUBLIC_PAGE_PATHS) {
      expect(
        urls.some((url) => new URL(url).pathname === path),
        `sitemap is missing ${path}`
      ).toBe(true);
    }
  });

  it("gives the homepage the highest priority", async () => {
    (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    });
    const sitemapModule = await import("@/app/sitemap");
    const result = await sitemapModule.default();
    const home = result.find(
      (entry: { url: string }) => new URL(entry.url).pathname === "/"
    );
    expect(home?.priority).toBe(1);
  });
});
