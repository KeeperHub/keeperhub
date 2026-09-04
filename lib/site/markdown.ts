/**
 * Markdown renderer for the public pages.
 *
 * Renders the same SitePage structure the React pages render, so the HTML and
 * markdown representations of a URL cannot say different things - the point of
 * serving both under one URL with `Vary: Accept`.
 */

import type {
  SiteLink,
  SitePage,
  SiteSection,
  SiteTable,
} from "@/lib/site/content";
import { appUrl, docsUrl } from "@/lib/site/identity";

/**
 * Escapes the characters that would break out of a markdown table cell.
 *
 * Backslashes first, and that order is the whole point: escaping `|` while
 * leaving `\` alone turns a cell ending in a backslash into `...\\|`, where the
 * doubled backslash renders as a literal and the pipe goes back to being a
 * column delimiter - so the escaping undoes itself. Every value here is
 * currently deployment config or a billing plan, but an escaper that is only
 * correct for its present callers is a trap for the next one.
 */
function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function absolute(href: string, origin: string): string {
  return href.startsWith("/") ? `${origin}${href}` : href;
}

function renderLink(link: SiteLink, origin: string): string {
  const target = `- [${link.label}](${absolute(link.href, origin)})`;
  return link.description ? `${target}: ${link.description}` : target;
}

function renderTable(table: SiteTable): string {
  const header = `| ${table.headers.map(escapeCell).join(" | ")} |`;
  const divider = `| ${table.headers.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map(
    (row) => `| ${row.map(escapeCell).join(" | ")} |`
  );
  return [header, divider, ...rows].join("\n");
}

function renderSection(section: SiteSection, origin: string): string {
  const blocks: string[] = [`## ${section.heading}`];
  if (section.paragraphs) {
    blocks.push(...section.paragraphs);
  }
  if (section.bullets) {
    blocks.push(section.bullets.map((bullet) => `- ${bullet}`).join("\n"));
  }
  if (section.table) {
    blocks.push(renderTable(section.table));
  }
  if (section.code) {
    blocks.push(
      `\`\`\`${section.code.language}\n${section.code.source}\n\`\`\``
    );
  }
  if (section.links) {
    blocks.push(
      section.links.map((link) => renderLink(link, origin)).join("\n")
    );
  }
  return blocks.join("\n\n");
}

/**
 * Render a page as CommonMark. The leading `# ` heading and the blockquoted
 * description match the llms.txt convention, so the same document reads
 * naturally whether it arrives through content negotiation or a crawl.
 */
export function renderPageMarkdown(page: SitePage): string {
  const origin = appUrl();
  const blocks: string[] = [
    `# ${page.heading}`,
    `> ${page.description}`,
    ...page.sections.map((section) => renderSection(section, origin)),
  ];
  blocks.push(
    [
      "---",
      "",
      `Canonical URL: ${absolute(page.path, origin)}`,
      `Documentation: ${docsUrl()}`,
      `Machine-readable index: ${docsUrl()}/llms.txt`,
      `OpenAPI: ${origin}/openapi.json`,
      `Sitemap: ${origin}/sitemap.xml`,
    ].join("\n")
  );
  return `${blocks.join("\n\n")}\n`;
}
