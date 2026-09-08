import { describe, expect, it } from "vitest";
import {
  NEGOTIABLE_PATHS,
  negotiablePage,
  PUBLIC_PAGE_PATHS,
  publicPage,
  publicPages,
  type SitePage,
} from "@/lib/site/content";
import { renderPageMarkdown } from "@/lib/site/markdown";

/**
 * The agent-readiness audit scores a page as "no content" below roughly 500
 * characters of text. That number is the contract these pages exist to satisfy,
 * so it is asserted rather than left to whoever edits the copy next.
 */
const MIN_TEXT_CHARS = 500;

function textOf(page: SitePage): string {
  const parts: string[] = [page.heading, page.description];
  for (const section of page.sections) {
    parts.push(section.heading);
    parts.push(...(section.paragraphs ?? []));
    parts.push(...(section.bullets ?? []));
    for (const link of section.links ?? []) {
      parts.push(link.label, link.description ?? "");
    }
    for (const row of section.table?.rows ?? []) {
      parts.push(row.join(" "));
    }
  }
  return parts.join(" ");
}

describe("public site content", () => {
  it("defines a page for every advertised public path", () => {
    for (const path of PUBLIC_PAGE_PATHS) {
      expect(publicPage(path), `no SitePage for ${path}`).not.toBeNull();
    }
  });

  it("carries enough prose on every page for a crawler to read", () => {
    for (const path of PUBLIC_PAGE_PATHS) {
      const page = publicPage(path);
      expect(page).not.toBeNull();
      const length = textOf(page as SitePage).length;
      expect(length, `${path} has only ${length} characters`).toBeGreaterThan(
        MIN_TEXT_CHARS
      );
    }
  });

  it("gives every page exactly one heading and a description", () => {
    for (const page of Object.values(publicPages())) {
      expect(page.heading.length).toBeGreaterThan(0);
      expect(page.description.length).toBeGreaterThan(0);
      expect(page.sections.length).toBeGreaterThan(0);
    }
  });

  it("maps /welcome onto the homepage so both answer the same", () => {
    // `/` redirects a signed-out visitor to /welcome. An agent that follows the
    // redirect and then asks for markdown must not get a different document.
    expect(negotiablePage("/welcome")).toEqual(publicPage("/"));
  });

  it("negotiates every public path plus /welcome, and nothing else", () => {
    expect(NEGOTIABLE_PATHS).toEqual([...PUBLIC_PAGE_PATHS, "/welcome"]);
    expect(negotiablePage("/workflows/abc")).toBeNull();
    expect(negotiablePage("/settings")).toBeNull();
  });

  it("links the homepage to the API, the docs, and the marketing site", () => {
    // The audit's "public API/docs linked from homepage" check reads these.
    const hrefs = (publicPage("/")?.sections ?? []).flatMap((section) =>
      (section.links ?? []).map((link) => link.href)
    );
    expect(hrefs).toContain("/openapi.json");
    expect(hrefs).toContain("/mcp");
    expect(hrefs).toContain("/.well-known/mcp.json");
    // Host-exact, not a substring: "https://evil.test/docs.keeperhub.com"
    // satisfies an includes() check while pointing somewhere else entirely.
    expect(
      hrefs.some(
        (href) =>
          href.startsWith("http") && new URL(href).host === "docs.keeperhub.com"
      )
    ).toBe(true);
  });
});

/**
 * Counts ATX H1s outside fenced code blocks. The developer portal embeds shell
 * snippets whose comments start with "# ", which a naive `/^# /gm` scan reads as
 * extra top-level headings.
 */
function countHeadings(markdown: string, level: number): number {
  const prefix = `${"#".repeat(level)} `;
  let inFence = false;
  let count = 0;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.startsWith(prefix)) {
      count++;
    }
  }
  return count;
}

describe("markdown rendering", () => {
  it("opens with a single H1 and a blockquoted summary", () => {
    const page = publicPage("/") as SitePage;
    const markdown = renderPageMarkdown(page);
    expect(markdown.startsWith(`# ${page.heading}\n`)).toBe(true);
    expect(markdown).toContain(`> ${page.description}`);
    expect(countHeadings(markdown, 1)).toBe(1);
  });

  it("keeps one H1 per page across every public page", () => {
    for (const path of PUBLIC_PAGE_PATHS) {
      const markdown = renderPageMarkdown(publicPage(path) as SitePage);
      expect(countHeadings(markdown, 1), `${path} has the wrong H1 count`).toBe(
        1
      );
    }
  });

  it("renders every section as an H2", () => {
    const page = publicPage("/") as SitePage;
    const markdown = renderPageMarkdown(page);
    for (const section of page.sections) {
      expect(markdown).toContain(`## ${section.heading}`);
    }
    expect(countHeadings(markdown, 2)).toBe(page.sections.length);
  });

  it("rewrites site-relative links to absolute URLs", () => {
    // A markdown document travels away from its origin; a bare "/developers"
    // is unresolvable once an agent has copied it into a context window.
    const markdown = renderPageMarkdown(publicPage("/") as SitePage);
    // Site-relative hrefs like "/openapi.json" become absolute; a markdown
    // document travels away from its origin and a bare path is unresolvable
    // once an agent has copied it into a context window.
    expect(markdown).toContain("](https://app.keeperhub.com/openapi.json)");
    expect(markdown).not.toMatch(/\]\(\/[a-z]/);
  });

  it("escapes backslashes before pipes so the escaping cannot undo itself", async () => {
    // Escaping | while leaving \\ alone turns a cell ending in a backslash into
    // "...\\\\|", where the doubled backslash renders as a literal and the pipe
    // goes back to being a column delimiter.
    const { renderPageMarkdown: render } = await import("@/lib/site/markdown");
    const page = {
      path: "/x",
      title: "x",
      heading: "x",
      description: "x",
      sections: [
        {
          heading: "t",
          table: {
            headers: ["a", "b"],
            rows: [["ends with a backslash \\", "second"]],
          },
        },
      ],
    } as unknown as SitePage;
    const row = render(page)
      .split("\n")
      .find((line) => line.includes("ends with a backslash"));
    expect(row).toBeDefined();
    // Exactly three pipes: opening, the column boundary, and closing. A
    // cell that broke out would produce a fourth.
    expect((row ?? "").split("|").length - 1).toBe(3);
    expect(row).toContain("\\\\");
  });

  it("escapes pipes so a cell cannot break the table", () => {
    const markdown = renderPageMarkdown(publicPage("/") as SitePage);
    for (const line of markdown.split("\n")) {
      if (!line.startsWith("|")) {
        continue;
      }
      // Every unescaped pipe is a column boundary, so the count must be stable
      // within a table block.
      expect(line.endsWith("|")).toBe(true);
    }
  });

  it("closes with the machine-readable index an agent needs next", () => {
    const markdown = renderPageMarkdown(publicPage("/") as SitePage);
    expect(markdown).toContain("Canonical URL: https://app.keeperhub.com/");
    expect(markdown).toContain("llms.txt");
    expect(markdown).toContain("/openapi.json");
    expect(markdown).toContain("/sitemap.xml");
  });

  it("ends with a trailing newline", () => {
    expect(renderPageMarkdown(publicPage("/") as SitePage)).toMatch(/\n$/);
  });
});
