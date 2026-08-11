#!/usr/bin/env npx tsx

/**
 * Standalone page discovery CLI.
 *
 * Usage:
 *   pnpm discover /                           # Discover unauthenticated page
 *   pnpm discover / --auth                     # With authentication
 *   pnpm discover / --highlight                # With numbered element overlays
 *   pnpm discover / --auth --steps "click:button:has-text('New')" "probe:after"
 *   pnpm discover / --json                     # JSON to stdout
 *
 * Output: tests/e2e/playwright/.probes/<label>-<timestamp>/
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import { signIn } from "./utils/auth";
import {
  PERSISTENT_TEST_PASSWORD,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import {
  clearHighlights,
  type DiscoveryReport,
  diffReports,
  formatDiff,
  highlightElements,
  printReport,
  probe,
} from "./utils/discover";

expand(config());

interface CliOptions {
  path: string;
  auth: boolean;
  highlight: boolean;
  json: boolean;
  label: string;
  steps: string[];
  baseUrl: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI entry point with inherent branching for argument parsing
function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    path: "/",
    auth: false,
    highlight: false,
    json: false,
    label: "discover",
    steps: [],
    baseUrl: process.env.BASE_URL || "http://localhost:3000",
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--auth") {
      options.auth = true;
    } else if (arg === "--highlight") {
      options.highlight = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--label" && args[i + 1]) {
      i++;
      options.label = args[i];
    } else if (arg === "--base-url" && args[i + 1]) {
      i++;
      options.baseUrl = args[i];
    } else if (arg === "--steps") {
      i++;
      while (i < args.length && !args[i].startsWith("--")) {
        options.steps.push(args[i]);
        i++;
      }
      continue;
    } else if (!arg.startsWith("--")) {
      options.path = arg.startsWith("/") ? arg : `/${arg}`;
    }

    i++;
  }

  return options;
}

async function executeStep(page: Page, step: string): Promise<void> {
  const colonIdx = step.indexOf(":");
  const action = colonIdx === -1 ? step : step.substring(0, colonIdx);
  const value = colonIdx === -1 ? "" : step.substring(colonIdx + 1);

  switch (action) {
    case "click":
      await page.locator(value).click();
      break;
    case "fill": {
      const eqIdx = value.indexOf("=");
      const selector = value.substring(0, eqIdx);
      const text = value.substring(eqIdx + 1);
      await page.locator(selector).fill(text);
      break;
    }
    case "wait":
      await page.waitForTimeout(Number.parseInt(value, 10) || 1000);
      break;
    case "goto":
      await page.goto(value, { waitUntil: "domcontentloaded" });
      break;
    case "probe":
      await probe(page, value || "step");
      break;
    default:
      console.error(`Unknown step action: ${action}`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-step page discovery requires sequential branching
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Page Discovery CLI - Capture page state for writing Playwright tests

Usage: pnpm discover <path> [options]

Options:
  --auth          Authenticate as persistent test user before navigating
  --highlight     Add numbered red overlays to interactive elements
  --json          Output report as JSON to stdout
  --label <name>  Name for the probe output directory (default: "discover")
  --base-url <url> Base URL (default: BASE_URL env or http://localhost:3000)
  --steps <...>   Execute steps before final probe. Step format:
                    click:<selector>       Click an element
                    fill:<selector>=<text> Fill an input
                    wait:<ms>              Wait N milliseconds
                    goto:<path>            Navigate to path
                    probe:<label>          Take intermediate probe

Examples:
  pnpm discover /
  pnpm discover /workflow/abc --auth --highlight
  pnpm discover / --auth --steps "click:button:has-text('New')" "probe:after-click"
`);
    process.exit(0);
  }

  const options = parseArgs(args);

  const authStatePath = resolve(
    process.cwd(),
    "tests/e2e/playwright/.auth/user.json"
  );
  const hasAuthState = options.auth && existsSync(authStatePath);

  const browser = await chromium.launch({ headless: true });

  const context = hasAuthState
    ? await browser.newContext({
        storageState: JSON.parse(readFileSync(authStatePath, "utf-8")),
      })
    : await browser.newContext();

  if (hasAuthState) {
    console.log("Using saved auth state");
  }

  const page = await context.newPage();

  try {
    if (options.auth && !hasAuthState) {
      console.log(`Signing in as ${PERSISTENT_TEST_USER_EMAIL}...`);
      await signIn(page, PERSISTENT_TEST_USER_EMAIL, PERSISTENT_TEST_PASSWORD);
      console.log("Signed in");
    }

    const url = `${options.baseUrl}${options.path}`;
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Track probes for auto-diffing between steps
    let lastProbe: DiscoveryReport | null = null;

    if (options.steps.length > 0) {
      // Take initial probe before any steps so we can diff
      lastProbe = await probe(page, `${options.label}-before`);
    }

    for (const step of options.steps) {
      console.log(`Step: ${step}`);

      const colonIdx = step.indexOf(":");
      const action = colonIdx === -1 ? step : step.substring(0, colonIdx);
      const value = colonIdx === -1 ? "" : step.substring(colonIdx + 1);

      if (action === "probe") {
        const current = await probe(page, value || "step");
        if (lastProbe) {
          const diff = diffReports(lastProbe, current);
          console.log(`\n--- Diff: ${diff.summary} ---\n`);
          const diffMd = formatDiff(diff);
          const probeDir = join(
            process.cwd(),
            "tests",
            "e2e",
            "playwright",
            ".probes"
          );
          const dirs = readdirSync(probeDir)
            .filter((d) => d.startsWith(value || "step"))
            .sort()
            .reverse();
          if (dirs[0]) {
            writeFileSync(join(probeDir, dirs[0], "diff.md"), diffMd);
          }
        }
        lastProbe = current;
      } else {
        await executeStep(page, step);
      }
    }

    if (options.highlight) {
      const elements = await highlightElements(page, { visible: true });
      console.log(`Highlighted ${elements.length} elements`);
    }

    const report = await probe(page, options.label);

    // Auto-diff against last probe if we had steps
    if (lastProbe) {
      const diff = diffReports(lastProbe, report);
      console.log(`\n--- Diff from last state: ${diff.summary} ---`);
      const probeDir = join(
        process.cwd(),
        "tests",
        "e2e",
        "playwright",
        ".probes"
      );
      const dirs = readdirSync(probeDir)
        .filter((d) => d.startsWith(options.label))
        .sort()
        .reverse();
      if (dirs[0]) {
        writeFileSync(join(probeDir, dirs[0], "diff.md"), formatDiff(diff));
      }
    }

    if (options.highlight) {
      const highlightedScreenshot = await page.screenshot({ fullPage: true });
      const probeDir = join(
        process.cwd(),
        "tests",
        "e2e",
        "playwright",
        ".probes"
      );
      const dirs = readdirSync(probeDir)
        .filter((d) => d.startsWith(options.label))
        .sort()
        .reverse();
      if (dirs[0]) {
        writeFileSync(
          join(probeDir, dirs[0], "screenshot-highlighted.png"),
          highlightedScreenshot
        );
      }
      await clearHighlights(page);
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
      console.log(
        `\nFull report saved to tests/e2e/playwright/.probes/${options.label}-*/`
      );
      console.log(
        "Files: screenshot.png, report.json, elements.md, accessibility.md, summary.txt"
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error("Discovery failed:", error);
  process.exit(1);
});
