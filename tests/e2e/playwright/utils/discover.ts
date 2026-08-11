import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// ------------------------------------------------------------------
// Top-level regex constants (useTopLevelRegex)
// ------------------------------------------------------------------

const RE_LIST_ITEM_PREFIX = /^(\s*)- /;
const RE_NON_WHITESPACE = /\S/;
const RE_ARIA_NODE = /^(\w+)(?:\s+"([^"]*)")?(?:\s+\[([^\]]+)\])?:?\s*$/;
const RE_COMMA_SEPARATED = /,\s*/;
const RE_SLASH = /\//g;
const RE_LEADING_DASH = /^-/;

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface ElementInfo {
  locator: string;
  tag: string;
  role: string | null;
  testId: string | null;
  id: string | null;
  text: string;
  ariaLabel: string | null;
  placeholder: string | null;
  inputType: string | null;
  visible: boolean;
  disabled: boolean;
  disabledReason: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  parentContext: string | null;
}

export interface PageStructure {
  title: string;
  url: string;
  headings: Array<{ level: number; text: string }>;
  landmarks: Array<{ role: string; label: string | null }>;
  dialogs: Array<{ title: string | null; visible: boolean }>;
  forms: Array<{ id: string | null; action: string | null; fields: number }>;
  navItems: string[];
  toasts: string[];
}

export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  level?: number;
  children?: AccessibilityNode[];
}

export interface DiscoveryReport {
  timestamp: string;
  structure: PageStructure;
  interactive: ElementInfo[];
  accessibility: AccessibilityNode | null;
  summary: string;
}

export interface StateDiff {
  url: { before: string; after: string };
  newElements: ElementInfo[];
  removedElements: ElementInfo[];
  newDialogs: Array<{ title: string | null }>;
  closedDialogs: Array<{ title: string | null }>;
  newToasts: string[];
  newHeadings: Array<{ level: number; text: string }>;
  removedHeadings: Array<{ level: number; text: string }>;
  summary: string;
}

// ------------------------------------------------------------------
// Core: getInteractiveElements
// ------------------------------------------------------------------

/**
 * Extract all interactive elements from the page with structured metadata.
 * Returns a flat list sorted by position (top-to-bottom, left-to-right).
 */
export async function getInteractiveElements(
  page: Page
): Promise<ElementInfo[]> {
  const elements: ElementInfo[] = await page.evaluate(() => {
    // tsx/esbuild injects __name decorators that don't exist in browser context
    // biome-ignore lint/suspicious/noExplicitAny: polyfill for esbuild decorator
    if (typeof (globalThis as any).__name === "undefined") {
      // biome-ignore lint/suspicious/noExplicitAny: polyfill for esbuild decorator
      (globalThis as any).__name = (target: any) => target;
    }

    const interactive = Array.from(
      document.querySelectorAll(
        [
          "a[href]",
          "button",
          "input",
          "select",
          "textarea",
          '[role="button"]',
          '[role="link"]',
          '[role="tab"]',
          '[role="menuitem"]',
          '[role="option"]',
          '[role="switch"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="combobox"]',
          '[role="listbox"]',
          '[role="slider"]',
          '[tabindex]:not([tabindex="-1"])',
          "[contenteditable]",
        ].join(", ")
      )
    );

    // Arrow functions to avoid tsx/esbuild __name decorator injection
    // (function declarations get decorated, which breaks page.evaluate)
    const truncate = (str: string, max: number): string => {
      const cleaned = str.replace(/\s+/g, " ").trim();
      return cleaned.length > max ? `${cleaned.substring(0, max)}...` : cleaned;
    };

    const getParentContext = (el: Element): string | null => {
      let current = el.parentElement;
      while (current) {
        const role = current.getAttribute("role");
        const landmark = current.tagName.toLowerCase();
        if (
          role === "dialog" ||
          role === "navigation" ||
          role === "main" ||
          role === "banner" ||
          role === "complementary" ||
          landmark === "nav" ||
          landmark === "header" ||
          landmark === "main" ||
          landmark === "aside" ||
          landmark === "footer"
        ) {
          return (
            current.getAttribute("aria-label") ||
            current.getAttribute("data-testid") ||
            role ||
            landmark
          );
        }
        current = current.parentElement;
      }
      return null;
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: DOM element classification requires extensive branching
    const suggestLocator = (el: Element): string => {
      const testId = el.getAttribute("data-testid");
      if (testId) {
        return `[data-testid="${testId}"]`;
      }

      const role = el.getAttribute("role");
      const ariaLabel = el.getAttribute("aria-label");
      if (role && ariaLabel) {
        return `role=${role}[name="${ariaLabel}"]`;
      }

      const elId = el.getAttribute("id");
      if (elId) {
        return `#${elId}`;
      }

      const text = truncate(el.textContent || "", 40);
      const tag = el.tagName.toLowerCase();
      if (tag === "button" && text) {
        return `button:has-text("${text}")`;
      }
      if (tag === "a" && text) {
        return `a:has-text("${text}")`;
      }

      if (role) {
        return `[role="${role}"]`;
      }

      const name = el.getAttribute("name");
      if (name) {
        return `[name="${name}"]`;
      }

      const ph = el.getAttribute("placeholder");
      if (ph) {
        return `[placeholder="${ph}"]`;
      }

      return tag;
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: browser-context function with independent disability checks, cannot be extracted
    const getDisabledReason = (el: Element): string | null => {
      const reasons: string[] = [];

      if ((el as HTMLButtonElement).disabled) {
        reasons.push("disabled attribute");
      }
      if (el.getAttribute("aria-disabled") === "true") {
        reasons.push("aria-disabled");
      }

      // Check parent fieldset[disabled]
      let parent = el.parentElement;
      while (parent) {
        if (
          parent.tagName === "FIELDSET" &&
          (parent as HTMLFieldSetElement).disabled
        ) {
          reasons.push("parent fieldset[disabled]");
          break;
        }
        parent = parent.parentElement;
      }

      const style = window.getComputedStyle(el);
      if (style.pointerEvents === "none") {
        reasons.push("pointer-events: none");
      }

      // Check aria-busy on self or ancestors
      let busyEl: Element | null = el;
      while (busyEl) {
        if (busyEl.getAttribute("aria-busy") === "true") {
          reasons.push(busyEl === el ? "aria-busy" : "ancestor aria-busy");
          break;
        }
        busyEl = busyEl.parentElement;
      }

      // Check for nearby loading indicators
      const parentEl = el.parentElement;
      if (parentEl) {
        const loadingIndicator = parentEl.querySelector(
          '[class*="loading"], [class*="spinner"], [data-loading]'
        );
        if (loadingIndicator) {
          reasons.push("loading indicator nearby");
        }
      }

      return reasons.length > 0 ? reasons.join("; ") : null;
    };

    const results: Array<{
      locator: string;
      tag: string;
      role: string | null;
      testId: string | null;
      id: string | null;
      text: string;
      ariaLabel: string | null;
      placeholder: string | null;
      inputType: string | null;
      visible: boolean;
      disabled: boolean;
      disabledReason: string | null;
      bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
      parentContext: string | null;
    }> = [];

    for (const el of interactive) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isVisible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0;

      results.push({
        locator: suggestLocator(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        testId: el.getAttribute("data-testid"),
        id: el.getAttribute("id"),
        text: truncate(el.textContent || "", 80),
        ariaLabel: el.getAttribute("aria-label"),
        placeholder: el.getAttribute("placeholder"),
        inputType:
          el.tagName === "INPUT" ? (el as HTMLInputElement).type : null,
        visible: isVisible,
        disabled:
          (el as HTMLButtonElement).disabled ||
          el.getAttribute("aria-disabled") === "true",
        disabledReason: getDisabledReason(el),
        bounds: isVisible
          ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            }
          : null,
        parentContext: getParentContext(el),
      });
    }

    results.sort((a, b) => {
      if (!(a.bounds && b.bounds)) {
        return 0;
      }
      const yDiff = a.bounds.y - b.bounds.y;
      if (Math.abs(yDiff) > 10) {
        return yDiff;
      }
      return a.bounds.x - b.bounds.x;
    });

    return results;
  });

  return elements;
}

// ------------------------------------------------------------------
// Core: getPageStructure
// ------------------------------------------------------------------

/**
 * Extract semantic page structure: headings, landmarks, dialogs, forms, nav.
 */
export async function getPageStructure(page: Page): Promise<PageStructure> {
  const title = await page.title();
  const url = page.url();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: accessibility tree traversal with many node types
  const structure = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: polyfill for esbuild decorator
    if (typeof (globalThis as any).__name === "undefined") {
      // biome-ignore lint/suspicious/noExplicitAny: polyfill for esbuild decorator
      (globalThis as any).__name = (target: any) => target;
    }

    const truncate = (str: string, max: number): string => {
      const cleaned = str.replace(/\s+/g, " ").trim();
      return cleaned.length > max ? `${cleaned.substring(0, max)}...` : cleaned;
    };

    const headings: Array<{ level: number; text: string }> = [];
    const headingEls = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6")
    );
    for (const h of headingEls) {
      headings.push({
        level: Number.parseInt(h.tagName[1], 10),
        text: truncate(h.textContent || "", 60),
      });
    }

    const landmarks: Array<{ role: string; label: string | null }> = [];
    const landmarkEls = Array.from(
      document.querySelectorAll(
        [
          "header",
          "nav",
          "main",
          "aside",
          "footer",
          '[role="banner"]',
          '[role="navigation"]',
          '[role="main"]',
          '[role="complementary"]',
          '[role="contentinfo"]',
          '[role="search"]',
        ].join(", ")
      )
    );
    for (const el of landmarkEls) {
      landmarks.push({
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        label: el.getAttribute("aria-label"),
      });
    }

    const dialogs: Array<{ title: string | null; visible: boolean }> = [];
    const dialogEls = Array.from(
      document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')
    );
    for (const d of dialogEls) {
      const titleEl = d.querySelector("h1, h2, h3, [class*=title]");
      const style = window.getComputedStyle(d);
      dialogs.push({
        title: titleEl ? truncate(titleEl.textContent || "", 60) : null,
        visible: style.display !== "none" && style.visibility !== "hidden",
      });
    }

    const forms: Array<{
      id: string | null;
      action: string | null;
      fields: number;
    }> = [];
    const formEls = Array.from(document.querySelectorAll("form"));
    for (const f of formEls) {
      forms.push({
        id: f.getAttribute("id"),
        action: f.getAttribute("action"),
        fields: f.querySelectorAll("input, select, textarea").length,
      });
    }

    const navItems: string[] = [];
    const navEls = Array.from(
      document.querySelectorAll("nav, [role=navigation]")
    );
    for (const navEl of navEls) {
      const links = Array.from(navEl.querySelectorAll("a"));
      for (const link of links) {
        const text = truncate(link.textContent || "", 40);
        if (text) {
          navItems.push(text);
        }
      }
    }

    const toasts: string[] = [];
    const toastEls = Array.from(
      document.querySelectorAll(
        "[data-sonner-toast], [role=status], [role=alert]"
      )
    );
    for (const toastEl of toastEls) {
      const text = truncate(toastEl.textContent || "", 80);
      if (text) {
        toasts.push(text);
      }
    }

    return { headings, landmarks, dialogs, forms, navItems, toasts };
  });

  return { title, url, ...structure };
}

// ------------------------------------------------------------------
// Core: getAccessibilityTree
// ------------------------------------------------------------------

/**
 * Get the ARIA snapshot from Playwright (v1.49+).
 * Uses locator.ariaSnapshot() which returns a YAML-like string showing
 * the accessibility tree: roles, names, values, and states.
 * This maps directly to Playwright's getByRole/getByLabel locators.
 */
export async function getAccessibilityTree(
  page: Page
): Promise<AccessibilityNode | null> {
  try {
    const snapshot = await page.locator("body").ariaSnapshot();
    if (!snapshot) {
      return null;
    }

    // Parse the YAML-like aria snapshot into our AccessibilityNode structure
    return parseAriaSnapshot(snapshot);
  } catch {
    // Fallback: ariaSnapshot not available
    return null;
  }
}

/**
 * Parse Playwright's YAML-like aria snapshot format into structured nodes.
 * Format is like:
 *   - banner:
 *     - link "KeeperHub Logo"
 *     - button "Sign In"
 *   - main:
 *     - button "Start building"
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: element grouping logic with multiple region detection heuristics
function parseAriaSnapshot(snapshot: string): AccessibilityNode {
  const lines = snapshot.split("\n").filter((l) => l.trim().length > 0);
  const root: AccessibilityNode = { role: "page", name: "", children: [] };
  const stack: Array<{ node: AccessibilityNode; indent: number }> = [
    { node: root, indent: -2 },
  ];

  for (const line of lines) {
    const stripped = line.replace(RE_LIST_ITEM_PREFIX, "$1");
    const indent = line.search(RE_NON_WHITESPACE);
    const content = stripped.trim();

    // Parse role and name: "button "Sign In"" or "banner:" or "link "Home" [disabled]"
    const match = content.match(RE_ARIA_NODE);
    if (!match) {
      continue;
    }

    const role = match[1];
    const name = match[2] || "";
    const stateStr = match[3];
    const hasChildren = content.endsWith(":");

    const node: AccessibilityNode = { role, name };
    if (stateStr) {
      const states = stateStr.split(RE_COMMA_SEPARATED);
      for (const rawState of states) {
        const state = rawState.trim();
        if (state === "disabled") {
          node.disabled = true;
        }
        if (state === "checked") {
          node.checked = true;
        }
        if (state === "pressed") {
          node.pressed = true;
        }
        if (state === "expanded") {
          node.expanded = true;
        }
        if (state.startsWith("level=")) {
          node.level = Number.parseInt(state.split("=")[1], 10);
        }
      }
    }
    if (hasChildren) {
      node.children = [];
    }

    // Find parent based on indentation
    while (stack.length > 1 && (stack.at(-1)?.indent ?? -1) >= indent) {
      stack.pop();
    }
    const parentEntry = stack.at(-1);
    if (parentEntry) {
      if (!parentEntry.node.children) {
        parentEntry.node.children = [];
      }
      parentEntry.node.children.push(node);
    }

    if (hasChildren) {
      stack.push({ node, indent });
    }
  }

  return root;
}

/**
 * Get the raw ARIA snapshot string from Playwright.
 * This is the most compact, directly useful format for writing tests.
 */
export async function getAriaSnapshotRaw(page: Page): Promise<string | null> {
  try {
    return await page.locator("body").ariaSnapshot();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Core: diffReports
// ------------------------------------------------------------------

/**
 * Compare two discovery reports and return what changed.
 * Use this after an interaction to understand what appeared/disappeared.
 *
 * Usage:
 *   const before = await probe(page, "before-click");
 *   await page.click('button:has-text("Sign In")');
 *   const after = await probe(page, "after-click");
 *   const diff = diffReports(before, after);
 */
export function diffReports(
  before: DiscoveryReport,
  after: DiscoveryReport
): StateDiff {
  const elementKey = (el: ElementInfo): string =>
    `${el.locator}|${el.tag}|${el.testId || ""}|${el.id || ""}`;

  const beforeKeys = new Set(
    before.interactive.filter((e) => e.visible).map(elementKey)
  );
  const afterKeys = new Set(
    after.interactive.filter((e) => e.visible).map(elementKey)
  );

  const newElements = after.interactive
    .filter((e) => e.visible)
    .filter((e) => !beforeKeys.has(elementKey(e)));
  const removedElements = before.interactive
    .filter((e) => e.visible)
    .filter((e) => !afterKeys.has(elementKey(e)));

  const beforeDialogTitles = new Set(
    before.structure.dialogs.filter((d) => d.visible).map((d) => d.title)
  );
  const afterDialogTitles = new Set(
    after.structure.dialogs.filter((d) => d.visible).map((d) => d.title)
  );
  const newDialogs = after.structure.dialogs
    .filter((d) => d.visible)
    .filter((d) => !beforeDialogTitles.has(d.title))
    .map((d) => ({ title: d.title }));
  const closedDialogs = before.structure.dialogs
    .filter((d) => d.visible)
    .filter((d) => !afterDialogTitles.has(d.title))
    .map((d) => ({ title: d.title }));

  const beforeToasts = new Set(before.structure.toasts);
  const newToasts = after.structure.toasts.filter((t) => !beforeToasts.has(t));

  const headingKey = (h: { level: number; text: string }): string =>
    `${h.level}:${h.text}`;
  const beforeHeadings = new Set(before.structure.headings.map(headingKey));
  const afterHeadings = new Set(after.structure.headings.map(headingKey));
  const newHeadings = after.structure.headings.filter(
    (h) => !beforeHeadings.has(headingKey(h))
  );
  const removedHeadings = before.structure.headings.filter(
    (h) => !afterHeadings.has(headingKey(h))
  );

  const summaryParts: string[] = [];
  if (before.structure.url !== after.structure.url) {
    summaryParts.push(
      `URL changed: ${before.structure.url} -> ${after.structure.url}`
    );
  }
  if (newDialogs.length > 0) {
    summaryParts.push(
      `Opened: ${newDialogs.map((d) => d.title || "(untitled dialog)").join(", ")}`
    );
  }
  if (closedDialogs.length > 0) {
    summaryParts.push(
      `Closed: ${closedDialogs.map((d) => d.title || "(untitled dialog)").join(", ")}`
    );
  }
  if (newElements.length > 0) {
    summaryParts.push(`${newElements.length} new elements appeared`);
  }
  if (removedElements.length > 0) {
    summaryParts.push(`${removedElements.length} elements disappeared`);
  }
  if (newToasts.length > 0) {
    summaryParts.push(`Toasts: ${newToasts.join(", ")}`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push("No visible changes detected");
  }

  return {
    url: {
      before: before.structure.url,
      after: after.structure.url,
    },
    newElements,
    removedElements,
    newDialogs,
    closedDialogs,
    newToasts,
    newHeadings,
    removedHeadings,
    summary: summaryParts.join("\n"),
  };
}

/**
 * Format a state diff as readable markdown.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: markdown report generation with many section types
export function formatDiff(diff: StateDiff): string {
  const lines: string[] = [];
  lines.push("# State Diff");
  lines.push("");

  if (diff.url.before !== diff.url.after) {
    lines.push(`URL: ${diff.url.before} -> ${diff.url.after}`);
    lines.push("");
  }

  if (diff.newDialogs.length > 0) {
    lines.push("## Dialogs Opened");
    for (const d of diff.newDialogs) {
      lines.push(`- ${d.title || "(untitled)"}`);
    }
    lines.push("");
  }

  if (diff.closedDialogs.length > 0) {
    lines.push("## Dialogs Closed");
    for (const d of diff.closedDialogs) {
      lines.push(`- ${d.title || "(untitled)"}`);
    }
    lines.push("");
  }

  if (diff.newToasts.length > 0) {
    lines.push("## New Toasts");
    for (const t of diff.newToasts) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  if (diff.newElements.length > 0) {
    lines.push("## New Elements");
    lines.push("");
    lines.push("| Locator | Tag | Text | Disabled | Why Disabled |");
    lines.push("|---------|-----|------|----------|--------------|");
    for (const el of diff.newElements) {
      const text = el.text || el.ariaLabel || el.placeholder || "-";
      lines.push(
        `| \`${el.locator}\` | ${el.tag} | ${text.substring(0, 40)} | ${el.disabled ? "yes" : "-"} | ${el.disabledReason ?? "-"} |`
      );
    }
    lines.push("");
  }

  if (diff.removedElements.length > 0) {
    lines.push("## Removed Elements");
    lines.push("");
    lines.push("| Locator | Tag | Text |");
    lines.push("|---------|-----|------|");
    for (const el of diff.removedElements) {
      const text = el.text || el.ariaLabel || "-";
      lines.push(
        `| \`${el.locator}\` | ${el.tag} | ${text.substring(0, 40)} |`
      );
    }
    lines.push("");
  }

  if (
    diff.newElements.length === 0 &&
    diff.removedElements.length === 0 &&
    diff.newDialogs.length === 0 &&
    diff.closedDialogs.length === 0 &&
    diff.newToasts.length === 0
  ) {
    lines.push("No visible changes detected.");
  }

  return lines.join("\n");
}

// ------------------------------------------------------------------
// Core: probe
// ------------------------------------------------------------------

const PROBE_DIR = join(process.cwd(), "tests", "e2e", "playwright", ".probes");

/**
 * Capture current page state: screenshot + element map + structure.
 * Saves to tests/e2e/playwright/.probes/<label>-<timestamp>/
 *
 * Drop this into any test to understand what's on screen:
 *   await probe(page, "after-login");
 *   await probe(page, "dialog-open");
 */
export async function probe(
  page: Page,
  label = "probe"
): Promise<DiscoveryReport> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dirName = `${label}-${timestamp}`;
  const outputDir = join(PROBE_DIR, dirName);
  mkdirSync(outputDir, { recursive: true });

  const [structure, interactive, accessibility, ariaRaw, screenshot] =
    await Promise.all([
      getPageStructure(page),
      getInteractiveElements(page),
      getAccessibilityTree(page),
      getAriaSnapshotRaw(page),
      page.screenshot({ fullPage: true }),
    ]);

  const visibleCount = interactive.filter((e) => e.visible).length;
  const hiddenCount = interactive.length - visibleCount;
  const withTestId = interactive.filter((e) => e.testId).length;

  const summary = [
    `Page: ${structure.title} (${structure.url})`,
    `Interactive elements: ${visibleCount} visible, ${hiddenCount} hidden`,
    `Elements with data-testid: ${withTestId}`,
    `Headings: ${structure.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join(", ")}`,
    structure.dialogs.length > 0
      ? `Open dialogs: ${structure.dialogs
          .filter((d) => d.visible)
          .map((d) => d.title)
          .join(", ")}`
      : "No open dialogs",
    structure.toasts.length > 0 ? `Toasts: ${structure.toasts.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const report: DiscoveryReport = {
    timestamp: new Date().toISOString(),
    structure,
    interactive,
    accessibility,
    summary,
  };

  writeFileSync(join(outputDir, "screenshot.png"), screenshot);
  writeFileSync(
    join(outputDir, "report.json"),
    JSON.stringify(report, null, 2)
  );
  writeFileSync(join(outputDir, "summary.txt"), summary);

  const claudeView = formatForClaude(report);
  writeFileSync(join(outputDir, "elements.md"), claudeView);

  if (accessibility) {
    const a11yView = formatAccessibilityTree(accessibility);
    writeFileSync(join(outputDir, "accessibility.md"), a11yView);
  }
  if (ariaRaw) {
    writeFileSync(join(outputDir, "aria-snapshot.yaml"), ariaRaw);
  }

  return report;
}

// ------------------------------------------------------------------
// Core: highlightElements
// ------------------------------------------------------------------

/**
 * Highlight interactive elements on the page with numbered red overlays.
 * Take an annotated screenshot afterward, then reference elements by number.
 */
export async function highlightElements(
  page: Page,
  filter?: { visible?: boolean }
): Promise<ElementInfo[]> {
  const elements = await getInteractiveElements(page);
  const filtered = elements.filter((el) => {
    if (filter?.visible !== undefined && el.visible !== filter.visible) {
      return false;
    }
    return true;
  });

  await page.evaluate(
    (
      els: Array<{
        bounds: { x: number; y: number; width: number; height: number } | null;
      }>
    ) => {
      const existing = Array.from(
        document.querySelectorAll("[data-pw-highlight]")
      );
      for (const item of existing) {
        item.remove();
      }

      for (const [i, el] of els.entries()) {
        if (!el.bounds) {
          continue;
        }

        const overlay = document.createElement("div");
        overlay.setAttribute("data-pw-highlight", String(i));
        overlay.style.cssText = [
          "position: fixed",
          `left: ${el.bounds.x}px`,
          `top: ${el.bounds.y}px`,
          `width: ${el.bounds.width}px`,
          `height: ${el.bounds.height}px`,
          "border: 2px solid #ff0000",
          "background: rgba(255, 0, 0, 0.1)",
          "z-index: 999999",
          "pointer-events: none",
          "box-sizing: border-box",
        ].join(";");

        const label = document.createElement("span");
        label.style.cssText = [
          "position: absolute",
          "top: -8px",
          "left: -8px",
          "background: #ff0000",
          "color: white",
          "font-size: 10px",
          "font-weight: bold",
          "padding: 1px 4px",
          "border-radius: 50%",
          "min-width: 16px",
          "text-align: center",
          "line-height: 16px",
          "font-family: monospace",
        ].join(";");
        label.textContent = String(i);
        overlay.appendChild(label);

        document.body.appendChild(overlay);
      }
    },
    filtered.map((el) => ({ bounds: el.bounds }))
  );

  return filtered;
}

/**
 * Remove all highlight overlays from the page.
 */
export async function clearHighlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    const highlights = Array.from(
      document.querySelectorAll("[data-pw-highlight]")
    );
    for (const highlight of highlights) {
      highlight.remove();
    }
  });
}

// ------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------

/**
 * Format the accessibility tree as indented markdown.
 * Shows role, name, and relevant states. This is the best data source
 * for writing getByRole/getByLabel locators.
 */
function formatAccessibilityTree(node: AccessibilityNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const parts: string[] = [];

  let line = `${indent}- **${node.role}**`;
  if (node.name) {
    line += ` "${node.name}"`;
  }
  if (node.value) {
    line += ` = "${node.value}"`;
  }

  const states: string[] = [];
  if (node.disabled) {
    states.push("disabled");
  }
  if (node.checked !== undefined) {
    states.push(`checked=${String(node.checked)}`);
  }
  if (node.pressed !== undefined) {
    states.push(`pressed=${String(node.pressed)}`);
  }
  if (node.expanded !== undefined) {
    states.push(`expanded=${String(node.expanded)}`);
  }
  if (node.level) {
    states.push(`level=${node.level}`);
  }
  if (states.length > 0) {
    line += ` (${states.join(", ")})`;
  }

  parts.push(line);

  if (node.children) {
    for (const child of node.children) {
      parts.push(formatAccessibilityTree(child, depth + 1));
    }
  }

  return parts.join("\n");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-step discovery orchestration
function formatForClaude(report: DiscoveryReport): string {
  const lines: string[] = [];

  lines.push(`# Page Discovery: ${report.structure.title}`);
  lines.push(`URL: ${report.structure.url}`);
  lines.push(`Captured: ${report.timestamp}`);
  lines.push("");

  if (report.structure.headings.length > 0) {
    lines.push("## Headings");
    for (const h of report.structure.headings) {
      lines.push(`${"  ".repeat(h.level - 1)}- ${h.text}`);
    }
    lines.push("");
  }

  if (report.structure.dialogs.some((d) => d.visible)) {
    lines.push("## Open Dialogs");
    for (const d of report.structure.dialogs.filter(
      (dialog) => dialog.visible
    )) {
      lines.push(`- ${d.title || "(untitled)"}`);
    }
    lines.push("");
  }

  if (report.structure.toasts.length > 0) {
    lines.push("## Toasts");
    for (const t of report.structure.toasts) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  const visible = report.interactive.filter((e) => e.visible);
  const groupedObj: Record<string, ElementInfo[]> = {};
  for (const el of visible) {
    const ctx = el.parentContext || "(page root)";
    if (!groupedObj[ctx]) {
      groupedObj[ctx] = [];
    }
    groupedObj[ctx].push(el);
  }

  lines.push("## Interactive Elements");
  lines.push("");

  const contexts = Object.keys(groupedObj);
  for (const context of contexts) {
    const elements = groupedObj[context];
    lines.push(`### ${context}`);
    lines.push("");
    lines.push("| # | Locator | Tag | Text | Disabled | Why Disabled |");
    lines.push("|---|---------|-----|------|----------|--------------|");
    for (const [i, el] of elements.entries()) {
      const text = el.text || el.ariaLabel || el.placeholder || "-";
      lines.push(
        `| ${i} | \`${el.locator}\` | ${el.tag} | ${text.substring(0, 40)} | ${el.disabled ? "yes" : "-"} | ${el.disabledReason ?? "-"} |`
      );
    }
    lines.push("");
  }

  const hidden = report.interactive.filter((e) => !e.visible);
  if (hidden.length > 0) {
    lines.push(
      `<details><summary>${hidden.length} hidden elements</summary>\n`
    );
    lines.push("| Locator | Tag | Text |");
    lines.push("|---------|-----|------|");
    for (const el of hidden) {
      const text = el.text || el.ariaLabel || "-";
      lines.push(
        `| \`${el.locator}\` | ${el.tag} | ${text.substring(0, 40)} |`
      );
    }
    lines.push("\n</details>");
  }

  if (report.accessibility) {
    lines.push("");
    lines.push("## Accessibility Tree");
    lines.push("");
    lines.push("Use this to write `getByRole` / `getByLabel` locators.");
    lines.push('Each line shows: **role** "accessible name" (states)');
    lines.push("");
    lines.push(formatAccessibilityTree(report.accessibility));
  }

  return lines.join("\n");
}

// ------------------------------------------------------------------
// Core: autoProbe
// ------------------------------------------------------------------

/**
 * Whether discovery mode is active.
 * Set PW_DISCOVER=1 to enable auto-probing in tests.
 * Off by default, and always off in CI.
 */
export function isDiscoveryMode(): boolean {
  if (process.env.CI) {
    return false;
  }
  return process.env.PW_DISCOVER === "1" || process.env.PW_DISCOVER === "true";
}

interface AutoProbeHandle {
  /** Stop listening and return all captured probes */
  stop: () => DiscoveryReport[];
  /** The last captured probe (or null if none yet) */
  lastProbe: () => DiscoveryReport | null;
}

/**
 * Attach auto-probing listeners to a page.
 * Automatically captures a probe on:
 *   - Main frame navigation (URL change)
 *   - Dialog open/close (DOM mutation on [role="dialog"])
 *
 * Only active when PW_DISCOVER=1 (or forced with force=true).
 * Always disabled in CI.
 *
 * Usage in tests:
 *   const handle = await autoProbe(page);
 *   // ... do your test interactions ...
 *   const probes = handle.stop();
 *
 * Or in playwright.config.ts globalSetup for all tests:
 *   if (isDiscoveryMode()) {
 *     test.beforeEach(async ({ page }) => { await autoProbe(page); });
 *   }
 */
export async function autoProbe(
  page: Page,
  options?: { force?: boolean }
): Promise<AutoProbeHandle> {
  const active = options?.force || isDiscoveryMode();
  const probes: DiscoveryReport[] = [];
  let lastReport: DiscoveryReport | null = null;
  let probeInProgress = false;
  let navigationCount = 0;

  // Declared here so `stop()` can reference it; assigned after definition below
  let onNavigation: ((frame: { url: () => string }) => Promise<void>) | null =
    null;

  const handle: AutoProbeHandle = {
    stop: () => {
      if (onNavigation) {
        page.removeListener("framenavigated", onNavigation);
      }
      return probes;
    },
    lastProbe: () => lastReport,
  };

  if (!active) {
    return handle;
  }

  const captureProbe = async (label: string): Promise<void> => {
    if (probeInProgress) {
      return;
    }
    probeInProgress = true;
    try {
      // Small delay to let the page settle after navigation
      await page.waitForLoadState("domcontentloaded").catch(() => {
        /* intentional noop */
      });
      await page.waitForTimeout(300);

      const before = lastReport;
      const report = await probe(page, label);
      probes.push(report);

      if (before) {
        const diff = diffReports(before, report);
        if (diff.summary !== "No visible changes detected") {
          const diffMd = formatDiff(diff);
          const probeDir = join(
            process.cwd(),
            "tests",
            "e2e",
            "playwright",
            ".probes"
          );
          const { readdirSync } = await import("node:fs");
          const dirs = readdirSync(probeDir)
            .filter((d) => d.startsWith(label))
            .sort()
            .reverse();
          if (dirs[0]) {
            writeFileSync(join(probeDir, dirs[0], "diff.md"), diffMd);
          }
        }
      }

      lastReport = report;
    } finally {
      probeInProgress = false;
    }
  };

  onNavigation = async (frame: { url: () => string }): Promise<void> => {
    // Only probe main frame navigations
    if (frame !== page.mainFrame()) {
      return;
    }

    navigationCount++;
    const url = new URL(frame.url());
    const pathLabel =
      url.pathname.replace(RE_SLASH, "-").replace(RE_LEADING_DASH, "") ||
      "root";
    await captureProbe(`auto-nav-${navigationCount}-${pathLabel}`);
  };

  page.on("framenavigated", onNavigation);

  // Take initial probe of current state
  await captureProbe("auto-initial");

  return handle;
}

/**
 * Print a compact discovery report to stdout.
 */
export function printReport(report: DiscoveryReport): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(report.summary);
  console.log("=".repeat(60));

  const visible = report.interactive.filter((e) => e.visible);
  console.log("\nVisible interactive elements:");
  console.log("-".repeat(60));

  for (const [i, el] of visible.entries()) {
    const text = el.text || el.ariaLabel || el.placeholder || "";
    const extra = [
      el.disabled ? "DISABLED" : "",
      el.inputType ? `type=${el.inputType}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    console.log(
      `  [${String(i).padStart(2)}] ${el.locator.padEnd(45)} ${el.tag.padEnd(8)} ${text.substring(0, 30).padEnd(32)} ${extra}`
    );
  }

  const hidden = report.interactive.filter((e) => !e.visible);
  if (hidden.length > 0) {
    console.log(`\n  (+ ${hidden.length} hidden elements)`);
  }

  if (report.accessibility) {
    console.log(`\n${"=".repeat(60)}`);
    console.log("Accessibility tree (interactive nodes):");
    console.log("-".repeat(60));
    const interactiveRoles = new Set([
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "slider",
      "switch",
      "tab",
      "menuitem",
      "option",
      "searchbox",
      "spinbutton",
    ]);
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: accessibility tree printing with recursive node handling
    const printA11yNode = (node: AccessibilityNode, depth: number): void => {
      const indent = "  ".repeat(depth);
      if (interactiveRoles.has(node.role)) {
        const states: string[] = [];
        if (node.disabled) {
          states.push("disabled");
        }
        if (node.checked !== undefined) {
          states.push(`checked=${String(node.checked)}`);
        }
        if (node.expanded !== undefined) {
          states.push(`expanded=${String(node.expanded)}`);
        }
        const stateStr = states.length > 0 ? ` [${states.join(", ")}]` : "";
        console.log(`${indent}${node.role}: "${node.name}"${stateStr}`);
      }
      if (node.children) {
        for (const child of node.children) {
          printA11yNode(
            child,
            depth + (interactiveRoles.has(node.role) ? 1 : 0)
          );
        }
      }
    };
    printA11yNode(report.accessibility, 1);
  }
}
