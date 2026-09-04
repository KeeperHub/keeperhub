import { describe, expect, it } from "vitest";
import { negotiate as appNegotiate } from "@/lib/site/accept";
import { AGENT_CRAWLER_USER_AGENTS } from "@/lib/site/crawlers";
import { negotiate as docsNegotiate } from "../../docs-site/lib/accept";
import { AGENT_CRAWLER_USER_AGENTS as docsCrawlers } from "../../docs-site/lib/crawlers";
import { mapContentFile } from "../../docs-site/scripts/emit-markdown.mjs";

/**
 * docs.keeperhub.com is built and shipped as its own image, and its Dockerfile
 * copies only `docs-site/` and `docs/`. The parent `lib/` is therefore absent at
 * both build and run time, so the Accept parser and the crawler allow-list have
 * to exist twice. These tests are what stops the two copies drifting.
 */
describe("docs Accept parser parity", () => {
  const HEADERS: (string | null)[] = [
    null,
    "",
    "   ",
    "*/*",
    "text/*",
    "text/markdown",
    "TEXT/MARKDOWN ;Q=0.9, text/html;q=0.1",
    "text/markdown;q=1.0, text/html;q=0.5",
    "text/markdown;q=0.8, text/html;q=0.8",
    "text/markdown;q=0, text/html",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "application/json",
    "*/*;q=0",
    "text/html;q=0, text/markdown;q=0",
    "*/*;q=0.1, text/markdown;q=0.9",
    "text/markdown;q=banana",
    "garbage, text/markdown;q=0.9",
  ];

  it("agrees with the app implementation on every header", () => {
    for (const header of HEADERS) {
      expect(
        docsNegotiate(header),
        `disagreement on Accept: ${JSON.stringify(header)}`
      ).toEqual(appNegotiate(header));
    }
  });

  it("still serves html to a browser and markdown to an agent", () => {
    // Guards against the two copies agreeing on the wrong answer.
    expect(
      docsNegotiate(
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      )
    ).toEqual({ kind: "html" });
    expect(docsNegotiate("text/markdown")).toEqual({ kind: "markdown" });
    expect(docsNegotiate("application/json")).toEqual({
      kind: "not-acceptable",
    });
  });
});

describe("docs crawler allow-list parity", () => {
  it("matches the app's list exactly", () => {
    // Both must also match rules 1 and 5 in the infrastructure repo's
    // cloudflare.tf; a UA invited in robots.txt and refused at the edge is
    // worse than either policy alone.
    expect([...docsCrawlers]).toEqual([...AGENT_CRAWLER_USER_AGENTS]);
  });

  it("excludes the crawlers the edge blocks everywhere", () => {
    for (const blocked of ["Bytespider", "Meta-ExternalAgent", "cohere-ai"]) {
      expect(docsCrawlers).not.toContain(blocked);
    }
  });
});

describe("docs middleware method handling", () => {
  /**
   * Calls the middleware rather than grepping its source.
   *
   * The first version of this asserted on the text of the method condition,
   * which is defeated in both directions: an early `if (request.method !==
   * "GET") return ...` above the gate reintroduces the bug with the string
   * still present, and extracting the condition into a variable, or a
   * formatter rewrapping it, breaks the test with behaviour unchanged. It also
   * grepped proxy.ts, so an unrelated refactor there failed a docs-site test.
   */
  async function call(
    path: string,
    {
      method = "GET",
      accept,
      rsc,
    }: { method?: string; accept?: string; rsc?: boolean } = {}
  ) {
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("../../docs-site/middleware");
    const headers = new Headers(accept ? { accept } : {});
    if (rsc) {
      headers.set("rsc", "1");
    }
    const request = new NextRequest(
      new URL(path, "https://docs.keeperhub.com"),
      { method, headers }
    );
    // docs-site is a separate pnpm workspace with its own next (16.3.2 against
    // the root's 16.2.11), so the two NextRequest types are structurally
    // distinct even though they are the same class at runtime. Same forced
    // duplication as lib/accept.ts. Cast through the callee's own parameter
    // type rather than `any`, so a real signature change still fails here.
    return middleware(request as unknown as Parameters<typeof middleware>[0]);
  }

  const MARKDOWN = "text/markdown";

  it("rewrites a GET that negotiates markdown to the emitted file", async () => {
    const res = await call("/api/authentication", { accept: MARKDOWN });
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/_md/api/authentication.md"
    );
    expect(res.headers.get("vary")).toContain("Accept");
  });

  it("rewrites a HEAD the same way, not just a GET", async () => {
    // The bug: gating on `method === "GET"` meant HEAD answered with HTML
    // headers while GET with the same Accept answered Markdown, so a client
    // probing with HEAD before fetching got the wrong content type.
    const res = await call("/api/authentication", {
      method: "HEAD",
      accept: MARKDOWN,
    });
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/_md/api/authentication.md"
    );
  });

  it("406s on HEAD as well as GET when nothing on offer is acceptable", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await call("/concepts", { method, accept: "image/png" });
      expect(res.status, `${method} did not 406`).toBe(406);
    }
  });

  it("leaves a browser on HTML for both methods", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await call("/concepts", {
        method,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("serves the explicit .md alternate on both methods", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await call("/api/authentication.md", { method });
      expect(res.headers.get("x-middleware-rewrite")).toContain(
        "/_md/api/authentication.md"
      );
    }
  });

  it("does not negotiate an RSC navigation", async () => {
    const res = await call("/concepts", { accept: MARKDOWN, rsc: true });
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("docs markdown emitter", () => {
  /**
   * Runs the real walker over a fixture tree rather than over build output.
   * An earlier version of this asserted on public/_md/manifest.json, which is
   * gitignored build output - so it passed locally after a docs build and
   * failed in CI, where unit tests run without one. Testing the emitter's
   * behaviour needs a tree it can walk, not a tree someone already built.
   */
  async function walkFixture(
    build: (root: string) => Promise<void> | void
  ): Promise<string[]> {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { walk } = await import("../../docs-site/scripts/emit-markdown.mjs");

    const root = await mkdtemp(join(tmpdir(), "emit-md-"));
    try {
      await build(root);
      const found: string[] = [];
      for await (const file of walk(root)) {
        found.push(file.slice(root.length + 1));
      }
      return found.sort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("finds markdown files, including nested ones", async () => {
    const found = await walkFixture(async (root) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(root, "index.md"), "# root");
      await mkdir(join(root, "api"), { recursive: true });
      await writeFile(join(root, "api", "auth.md"), "# auth");
      await writeFile(join(root, "notes.txt"), "ignored");
    });
    expect(found).toEqual(["api/auth.md", "index.md"]);
  });

  it("follows a symlink to a markdown file rather than dropping it", async () => {
    // readdir on a file symlink fails, and entry.isFile() reports the link
    // rather than its target - so before the stat() fallthrough the page was
    // skipped with no error, rendering as HTML while 404ing on both .md routes.
    const found = await walkFixture(async (root) => {
      const { mkdir, writeFile, symlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(root, "real"), { recursive: true });
      await writeFile(join(root, "real", "page.md"), "# page");
      await symlink(join(root, "real", "page.md"), join(root, "linked.md"));
    });
    expect(found).toContain("linked.md");
    expect(found).toContain("real/page.md");
  });

  it("follows a symlink to a directory, which is how content/ is wired", async () => {
    const found = await walkFixture(async (root) => {
      const { mkdir, writeFile, symlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(root, "elsewhere"), { recursive: true });
      await writeFile(join(root, "elsewhere", "deep.md"), "# deep");
      await symlink(join(root, "elsewhere"), join(root, "content"));
    });
    expect(found).toContain("content/deep.md");
  });

  it("ignores a dangling symlink instead of throwing", async () => {
    const found = await walkFixture(async (root) => {
      const { writeFile, symlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(root, "ok.md"), "# ok");
      await symlink(join(root, "missing.md"), join(root, "broken.md"));
    });
    expect(found).toEqual(["ok.md"]);
  });
});

describe("docs content-file to URL mapping", () => {
  it("maps the site root to index.md", () => {
    expect(mapContentFile("index.md")).toEqual({
      route: "/",
      output: "index.md",
    });
  });

  it("maps a section index to the section's own .md", () => {
    // /api is a page in its own right, so its Markdown twin is /api.md rather
    // than /api/index.md.
    expect(mapContentFile("api/index.md")).toEqual({
      route: "/api",
      output: "api.md",
    });
  });

  it("maps a leaf page alongside its siblings", () => {
    expect(mapContentFile("api/authentication.md")).toEqual({
      route: "/api/authentication",
      output: "api/authentication.md",
    });
  });

  it("maps a deeply nested page", () => {
    expect(mapContentFile("cli/commands/kh_auth.md")).toEqual({
      route: "/cli/commands/kh_auth",
      output: "cli/commands/kh_auth.md",
    });
  });

  it("preserves case, because the routes are case-sensitive", () => {
    // /FAQ serves 200 and /faq serves 404 on the live site.
    expect(mapContentFile("FAQ.md")).toEqual({
      route: "/FAQ",
      output: "FAQ.md",
    });
  });

  it("handles .mdx the same as .md", () => {
    expect(mapContentFile("guides/example.mdx")).toEqual({
      route: "/guides/example",
      output: "guides/example.md",
    });
  });
});
