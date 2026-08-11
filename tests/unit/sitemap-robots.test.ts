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

  it("points to a sitemap URL on the configured base URL", async () => {
    const robotsModule = await import("@/app/robots");
    const result = robotsModule.default();
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
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
});
