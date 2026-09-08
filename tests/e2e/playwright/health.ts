/**
 * Test Health Dashboard
 *
 * Standalone script that analyzes the state of Playwright E2E tests.
 * Reports test counts, fixture adoption, and probe usage.
 *
 * Usage: pnpm test:health
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";

const PLAYWRIGHT_DIR = join(process.cwd(), "tests", "e2e", "playwright");
const OUTPUT_FILE = join(process.cwd(), ".claude", "test-health.txt");
const TEST_FILE_PATTERN = /\.test\.ts$/;
const SETUP_FILE_PATTERN = /\.setup\.ts$/;

interface TestFileInfo {
  path: string;
  relativePath: string;
  testCount: number;
  testNames: string[];
  usesCustomFixture: boolean;
  usesProbe: boolean;
  isSetup: boolean;
  isExplore: boolean;
}

function analyzeTestFile(filePath: string): TestFileInfo {
  const content = readFileSync(filePath, "utf-8");
  const relativePath = relative(PLAYWRIGHT_DIR, filePath);
  const fileName = basename(filePath);

  const isSetup = fileName.endsWith(".setup.ts");
  const isExplore = fileName === "explore.test.ts";

  // Check import source
  const usesCustomFixture =
    content.includes('from "./fixtures"') ||
    content.includes('from "../fixtures"');

  // Check probe usage
  const usesProbe =
    content.includes("probe(") || content.includes("autoProbe(");

  // Parse test declarations
  const testNames: string[] = [];
  const testPattern = /test\(\s*["'`]([^"'`]+)["'`]/g;
  let match = testPattern.exec(content);
  while (match) {
    testNames.push(match[1]);
    match = testPattern.exec(content);
  }

  // Also check for test.only, test.skip
  const specialPattern = /test\.(only|skip)\(\s*["'`]([^"'`]+)["'`]/g;
  let specialMatch = specialPattern.exec(content);
  while (specialMatch) {
    testNames.push(`[${specialMatch[1]}] ${specialMatch[2]}`);
    specialMatch = specialPattern.exec(content);
  }

  return {
    path: filePath,
    relativePath,
    testCount: testNames.length,
    testNames,
    usesCustomFixture,
    usesProbe,
    isSetup,
    isExplore,
  };
}

function walkDir(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) {
    return results;
  }
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules") {
      continue;
    }
    if (statSync(fullPath).isDirectory()) {
      results.push(...walkDir(fullPath, pattern));
    } else if (pattern.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

function findTestFiles(): string[] {
  return walkDir(PLAYWRIGHT_DIR, TEST_FILE_PATTERN);
}

function findSetupFiles(): string[] {
  return walkDir(PLAYWRIGHT_DIR, SETUP_FILE_PATTERN);
}

function formatSummarySection(
  tests: TestFileInfo[],
  setups: TestFileInfo[]
): string[] {
  const lines: string[] = [];
  const totalTests = tests.reduce((sum, f) => sum + f.testCount, 0);
  const withFixture = tests.filter((f) => f.usesCustomFixture).length;
  const withProbe = tests.filter((f) => f.usesProbe).length;

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Test files | ${tests.length} |`);
  lines.push(`| Setup files | ${setups.length} |`);
  lines.push(`| Total test cases | ${totalTests} |`);
  lines.push(`| Using custom fixture | ${withFixture}/${tests.length} |`);
  lines.push(`| Using probe() | ${withProbe}/${tests.length} |`);
  lines.push("");
  return lines;
}

function formatCoverageGaps(tests: TestFileInfo[]): string[] {
  const missing = tests.filter((f) => !(f.usesCustomFixture || f.isExplore));
  if (missing.length === 0) {
    return [];
  }
  const lines: string[] = [];
  lines.push("## Coverage Gaps");
  lines.push("");
  for (const f of missing) {
    lines.push(
      `- **${f.relativePath}** - not using custom fixture (no auto-probe on failure)`
    );
  }
  lines.push("");
  return lines;
}

function formatFileNotes(f: TestFileInfo): string {
  const notes: string[] = [];
  if (f.isSetup) {
    notes.push("setup");
  }
  if (f.isExplore) {
    notes.push("explore harness");
  }
  if (!(f.usesCustomFixture || f.isSetup)) {
    notes.push("needs fixture");
  }
  return notes.join(", ") || "-";
}

function generateReport(files: TestFileInfo[]): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push("# Test Health Dashboard");
  lines.push(`Generated: ${now}`);
  lines.push("");

  const testFiles = files.filter((f) => !f.isSetup);
  const setupFiles = files.filter((f) => f.isSetup);

  lines.push(...formatSummarySection(testFiles, setupFiles));
  lines.push(...formatCoverageGaps(testFiles));

  // Per-file status table
  lines.push("## Per-File Status");
  lines.push("");
  lines.push("| File | Tests | Fixture | Probe | Notes |");
  lines.push("|------|-------|---------|-------|-------|");

  for (const f of files) {
    lines.push(
      `| ${f.relativePath} | ${f.testCount} | ${f.usesCustomFixture ? "yes" : "-"} | ${f.usesProbe ? "yes" : "-"} | ${formatFileNotes(f)} |`
    );
  }
  lines.push("");

  // Test list
  lines.push("## All Tests");
  lines.push("");
  for (const f of testFiles) {
    if (f.testCount === 0) {
      continue;
    }
    lines.push(`### ${f.relativePath}`);
    for (const name of f.testNames) {
      lines.push(`- ${name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Main
const testFiles = findTestFiles().map(analyzeTestFile);
const setupFiles = findSetupFiles().map(analyzeTestFile);
const allFiles = [...testFiles, ...setupFiles];

const report = generateReport(allFiles);

// Write to file
const outputDir = join(process.cwd(), ".claude");
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}
writeFileSync(OUTPUT_FILE, report);

// Print to stdout
console.log(report);
console.log(`\nWritten to: ${relative(process.cwd(), OUTPUT_FILE)}`);
