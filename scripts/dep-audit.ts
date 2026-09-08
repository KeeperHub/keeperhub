#!/usr/bin/env tsx

/**
 * Dependency Audit Script
 *
 * Combines knip's unused dependency detection with custom checks that
 * knip can't perform (codegen-only deps, CLI tools, transitive pins).
 *
 * Usage:
 *   pnpm dep-audit           # full audit
 *   pnpm dep-audit --json    # machine-readable output
 *
 * Exit codes:
 *   0 = no removable dependencies found
 *   1 = removable dependencies found
 */

import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const jsonMode = process.argv.includes("--json");

// Only allow valid npm package name characters to prevent shell injection
const SAFE_PKG_NAME = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;

function assertSafePackageName(pkg: string): void {
  if (!SAFE_PKG_NAME.test(pkg)) {
    throw new Error(`Refusing to process unsafe package name: ${pkg}`);
  }
}

// ---------------------------------------------------------------------------
// Known exceptions - deps that knip flags but are intentionally kept.
// Each entry documents WHY so the next person isn't guessing.
// ---------------------------------------------------------------------------

type ExceptionReason =
  | "cli-tool" // Invoked as a binary, not imported (e.g. biome)
  | "transitive-pin"; // Pinned to control version of a transitive dep

type Exception = {
  reason: ExceptionReason;
  detail: string;
};

const KNOWN_EXCEPTIONS: Record<string, Exception> = {
  "@biomejs/biome": {
    reason: "cli-tool",
    detail: "Required by ultracite (pnpm check/fix) which shells out to biome",
  },
};

// ---------------------------------------------------------------------------
// Codegen detection - packages referenced only as string literals in
// generated code (workflow-codegen-sdk.ts and friends)
// ---------------------------------------------------------------------------

const CODEGEN_FILES = [
  "lib/workflow/codegen/sdk.ts",
  "lib/workflow/codegen/shared.ts",
];

function detectCodegenOnlyDeps(): Set<string> {
  const codegenPackages = new Set<string>();
  const pattern = /imports\.add\(["'`]import .+ from ['"]([^'"]+)['"]/g;

  for (const file of CODEGEN_FILES) {
    try {
      const content = readFileSync(join(ROOT, file), "utf-8");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) codegenPackages.add(match[1]);
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  return codegenPackages;
}

// ---------------------------------------------------------------------------
// Source import detection - check if a package is actually imported in source
// ---------------------------------------------------------------------------

function hasSourceImport(pkg: string): { found: boolean; files: string[] } {
  try {
    // Use grep -r with --include because rg respects parent .gitignore and
    // this repo is nested inside a mega-repo whose gitignore can hide files.
    const result = execSync(
      `grep -r -l --include='*.ts' --include='*.tsx' -F "from '${pkg}'" . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.worktrees 2>/dev/null; grep -r -l --include='*.ts' --include='*.tsx' -F 'from "${pkg}"' . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.worktrees 2>/dev/null; true`,
      { cwd: ROOT, encoding: "utf-8" }
    ).trim();

    const files = [...new Set(result.split("\n").filter(Boolean))]
      .map((f) => f.replace(/^\.\//, ""))
      .filter((f) => !CODEGEN_FILES.includes(f));

    return { found: files.length > 0, files };
  } catch {
    return { found: false, files: [] };
  }
}

// ---------------------------------------------------------------------------
// CLI tool detection - check if a package provides binaries used in scripts
// ---------------------------------------------------------------------------

function isUsedAsCLI(pkg: string): boolean {
  try {
    const pkgJson = JSON.parse(
      readFileSync(join(ROOT, "node_modules", pkg, "package.json"), "utf-8")
    );
    const binNames = pkgJson.bin
      ? typeof pkgJson.bin === "string"
        ? [pkg.split("/").pop()]
        : Object.keys(pkgJson.bin)
      : [];

    if (binNames.length === 0) return false;

    // Check package.json scripts for direct references
    const rootPkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf-8")
    );
    const scriptContent = JSON.stringify(rootPkg.scripts || {});
    if (binNames.some((bin) => bin && scriptContent.includes(bin))) {
      return true;
    }

    // Check if any other direct dependency requires this package
    // (e.g. ultracite requires @biomejs/biome)
    try {
      const result = execSync(
        `pnpm why "${pkg}" 2>/dev/null | head -20`,
        { cwd: ROOT, encoding: "utf-8", timeout: 10000 }
      );
      const devDeps = Object.keys(rootPkg.devDependencies || {});
      const deps = Object.keys(rootPkg.dependencies || {});
      const allDirect = [...deps, ...devDeps];
      // Look for tree lines that show a direct dep depending on this package
      const treeLines = result.split("\n").filter(
        (l) => l.includes("└─") || l.includes("├─")
      );
      for (const line of treeLines) {
        for (const directDep of allDirect) {
          // Match exact package name followed by version (not substring)
          if (directDep !== pkg && line.includes(`${directDep} `)) {
            return true;
          }
        }
      }
    } catch {
      // pnpm why failed, skip
    }

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transitive pin detection - check if a package is already a transitive dep
// of something else in the tree
// ---------------------------------------------------------------------------

function isTransitiveDep(pkg: string): { is: boolean; parents: string[] } {
  try {
    const output = execSync(`pnpm why "${pkg}" 2>/dev/null`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 15000,
    });

    // Parse pnpm why output for dependency chains (indented lines with arrows)
    const parents: string[] = [];
    const lines = output.split("\n");
    for (const line of lines) {
      // Lines with tree characters indicate transitive dependency paths
      if (line.includes("└─") || line.includes("├─")) {
        const match = line.match(/([a-z@][a-z0-9_./-]+)\s+[\d.]/);
        if (match?.[1] && match[1] !== pkg) {
          parents.push(match[1]);
        }
      }
    }

    return { is: parents.length > 0, parents };
  } catch {
    return { is: false, parents: [] };
  }
}

// ---------------------------------------------------------------------------
// UI component re-export detection - check if a Radix/UI package is
// re-exported through a local wrapper (components/ui/*.tsx)
// ---------------------------------------------------------------------------

function isReExportedUIComponent(pkg: string): {
  is: boolean;
  wrapper: string | null;
} {
  if (!pkg.startsWith("@radix-ui/")) return { is: false, wrapper: null };

  try {
    const result = execSync(
      `grep -r -l --include='*.tsx' -F '${pkg}' components/ui/ 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf-8" }
    ).trim();

    const files = result.split("\n").filter(Boolean);
    return { is: files.length > 0, wrapper: files[0] || null };
  } catch {
    return { is: false, wrapper: null };
  }
}

// ---------------------------------------------------------------------------
// Plugin runtime detection - check if a package is imported in plugin step
// files that get loaded dynamically by discover-plugins
// ---------------------------------------------------------------------------

function isPluginRuntimeDep(pkg: string): {
  is: boolean;
  files: string[];
} {
  try {
    const result = execSync(
      `grep -r -l --include='*.ts' --include='*.tsx' -F "from '${pkg}'" plugins/ 2>/dev/null; grep -r -l --include='*.ts' --include='*.tsx' -F 'from "${pkg}"' plugins/ 2>/dev/null; true`,
      { cwd: ROOT, encoding: "utf-8" }
    ).trim();

    const files = result.split("\n").filter(Boolean);
    return { is: files.length > 0, files };
  } catch {
    return { is: false, files: [] };
  }
}

// ---------------------------------------------------------------------------
// Run knip
// ---------------------------------------------------------------------------

type KnipDep = { name: string; line: number; col: number; pos: number };
type KnipResult = {
  dependencies: KnipDep[];
  devDependencies: KnipDep[];
};

function runKnip(): KnipResult {
  // knip exits non-zero when it finds issues. Use a temp file to
  // capture stdout reliably regardless of exit code.
  const tmpFile = join(tmpdir(), `knip-dep-audit-${process.pid}.json`);
  let output: string;
  try {
    execSync(
      `npx knip --dependencies --reporter json > "${tmpFile}" 2>/dev/null; true`,
      { cwd: ROOT, encoding: "utf-8", timeout: 120000 }
    );
    output = readFileSync(tmpFile, "utf-8");
  } catch (err: unknown) {
    console.error(
      "Failed to run knip:",
      err instanceof Error ? err.message : err
    );
    process.exit(2);
  } finally {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // Best effort cleanup
    }
  }

  // knip json output may have non-JSON preamble (dotenv warnings on stdout)
  // Strip lines before the JSON object starts
  const lines = output.split("\n");
  const jsonLineIndex = lines.findIndex((l) => l.trimStart().startsWith("{"));
  if (jsonLineIndex === -1) return { dependencies: [], devDependencies: [] };

  const jsonStr = lines.slice(jsonLineIndex).join("\n");
  const data = JSON.parse(jsonStr);
  const pkgIssue = data.issues?.find(
    (i: { file: string }) => i.file === "package.json"
  );

  return {
    dependencies: pkgIssue?.dependencies || [],
    devDependencies: pkgIssue?.devDependencies || [],
  };
}

// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------

type AuditVerdict =
  | "removable"
  | "codegen-only"
  | "cli-tool"
  | "ui-wrapper"
  | "plugin-runtime"
  | "source-import"
  | "transitive-pin"
  | "exception";

type AuditEntry = {
  name: string;
  isDev: boolean;
  verdict: AuditVerdict;
  detail: string;
};

function auditDep(
  dep: KnipDep,
  isDev: boolean,
  codegenDeps: Set<string>
): AuditEntry {
  const name = dep.name;
  assertSafePackageName(name);

  // Check known exceptions first
  if (KNOWN_EXCEPTIONS[name]) {
    return {
      name,
      isDev,
      verdict: "exception",
      detail: `${KNOWN_EXCEPTIONS[name].reason}: ${KNOWN_EXCEPTIONS[name].detail}`,
    };
  }

  // Check if it's a re-exported UI component (e.g. radix via components/ui/)
  const uiCheck = isReExportedUIComponent(name);
  if (uiCheck.is) {
    return {
      name,
      isDev,
      verdict: "ui-wrapper",
      detail: `Re-exported via ${uiCheck.wrapper}`,
    };
  }

  // Check if it's used in plugin step files (dynamic imports via discover-plugins)
  const pluginCheck = isPluginRuntimeDep(name);
  if (pluginCheck.is) {
    return {
      name,
      isDev,
      verdict: "plugin-runtime",
      detail: `Used in ${pluginCheck.files.join(", ")}`,
    };
  }

  // Check if it has real source imports (outside codegen and plugin files)
  const sourceCheck = hasSourceImport(name);
  if (sourceCheck.found) {
    return {
      name,
      isDev,
      verdict: "source-import",
      detail: `Imported in ${sourceCheck.files.join(", ")}`,
    };
  }

  // Check if it's a codegen-only string reference
  if (codegenDeps.has(name)) {
    return {
      name,
      isDev,
      verdict: "codegen-only",
      detail:
        "Only referenced as string in codegen output, not a runtime import",
    };
  }

  // Check if it's a CLI tool used in scripts or required by other devDeps
  if (isUsedAsCLI(name)) {
    return {
      name,
      isDev,
      verdict: "cli-tool",
      detail: "Binary used in package.json scripts or required by a devDependency",
    };
  }

  // Check if it's a transitive dep (pinned for version control)
  const transitiveCheck = isTransitiveDep(name);
  if (transitiveCheck.is) {
    return {
      name,
      isDev,
      verdict: "transitive-pin",
      detail: `Transitive dep via ${transitiveCheck.parents.slice(0, 3).join(", ")}`,
    };
  }

  // Nothing found - it's removable
  return {
    name,
    isDev,
    verdict: "removable",
    detail: "No imports, no CLI usage, no transitive dependents",
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printResults(entries: AuditEntry[]): void {
  if (jsonMode) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const removable = entries.filter((e) => e.verdict === "removable");
  const codegenOnly = entries.filter((e) => e.verdict === "codegen-only");
  const kept = entries.filter(
    (e) => e.verdict !== "removable" && e.verdict !== "codegen-only"
  );

  if (removable.length > 0) {
    console.log("\n  REMOVABLE (safe to uninstall)\n");
    for (const e of removable) {
      const tag = e.isDev ? " (dev)" : "";
      console.log(`    ${e.name}${tag}`);
      console.log(`      ${e.detail}`);
    }
  }

  if (codegenOnly.length > 0) {
    console.log("\n  CODEGEN-ONLY (not a runtime dep - review if needed in package.json)\n");
    for (const e of codegenOnly) {
      console.log(`    ${e.name}`);
      console.log(`      ${e.detail}`);
    }
  }

  if (kept.length > 0) {
    console.log("\n  KEPT (knip flagged but actually used)\n");
    for (const e of kept) {
      const tag = e.isDev ? " (dev)" : "";
      console.log(`    ${e.name}${tag} [${e.verdict}]`);
      console.log(`      ${e.detail}`);
    }
  }

  console.log(
    `\n  Summary: ${removable.length} removable, ${codegenOnly.length} codegen-only, ${kept.length} kept\n`
  );

  if (removable.length > 0) {
    const names = removable.map((e) => e.name).join(" ");
    console.log(`  To remove: pnpm remove ${names}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("Running dependency audit...\n");
  console.log("  Step 1/2: Running knip...");

  const knipResult = runKnip();
  const totalFlagged =
    knipResult.dependencies.length + knipResult.devDependencies.length;

  console.log(`  Knip flagged ${totalFlagged} package(s)\n`);

  if (totalFlagged === 0) {
    console.log("  No unused dependencies found.\n");
    process.exit(0);
  }

  console.log("  Step 2/2: Running custom checks...");

  const codegenDeps = detectCodegenOnlyDeps();
  const entries: AuditEntry[] = [
    ...knipResult.dependencies.map((d) => auditDep(d, false, codegenDeps)),
    ...knipResult.devDependencies.map((d) => auditDep(d, true, codegenDeps)),
  ];

  printResults(entries);

  const removableCount = entries.filter(
    (e) => e.verdict === "removable"
  ).length;
  process.exit(removableCount > 0 ? 1 : 0);
}

main();
