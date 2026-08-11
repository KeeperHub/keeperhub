#!/usr/bin/env node

/**
 * Token Audit Script
 *
 * Scans CSS and component files for hardcoded visual values that should
 * use design tokens instead. CI-ready: exits with code 1 if errors found.
 *
 * Usage:
 *   node scripts/token-audit.js           # scan all files
 *   node scripts/token-audit.js --quiet   # errors only, no warnings
 *
 * Exit codes:
 *   0 = no errors (warnings may exist)
 *   1 = errors found (hardcoded colors, spacing in CSS)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const quietMode = process.argv.includes("--quiet");

// ----------------------------------------------------------------
// Directories to scan
// ----------------------------------------------------------------
const SCAN_DIRS = [
  "app",
  "components",
  "keeperhub/components",
  "keeperhub/app",
  "keeperhub/api",
];

// Files/directories to skip
const SKIP_PATTERNS = [
  "node_modules",
  ".next",
  "docs-site",
  "lib/workflow/codegen/boilerplate",
  // OG image generation is exempt (server-rendered images, not UI)
  "generate-og.tsx",
  // Monaco theme uses editor-specific theming API
  "monaco-theme.ts",
  // Palette constants are DB-stored hex values, not UI styling
  "keeperhub/lib/palette.ts",
  // Logo uses brand color directly in SVG paths
  "keeperhub/components/icons/keeperhub-logo.tsx",
  // Third-party agent marks use each vendor's official brand color in SVG paths
  "keeperhub/components/icons/agent-icons.tsx",
  // MCP schemas route has hex examples in documentation strings
  "keeperhub/api/mcp/schemas/route.ts",
];

// File extensions to scan
const SCAN_EXTENSIONS = new Set([".css", ".scss", ".tsx", ".ts", ".jsx"]);

// ----------------------------------------------------------------
// Token suggestions: maps detected patterns to recommended tokens
// ----------------------------------------------------------------

const COLOR_HEX_SUGGESTIONS = {
  "#09fd67": "--color-text-accent / --ds-green-accent",
  "#09fd671a": "--color-bg-accent / --ds-green-accent-10",
  "#00ff4f": "--ds-green-logo (logo only)",
  "#1a2230": "--color-hub-card / --ds-hub-surface-1",
  "#2a3342": "--color-hub-icon-bg / --ds-hub-surface-2",
  "#243548": "--color-hub-gradient-center / --ds-hub-surface-3",
  "#354155": "--color-hub-icon-bg-hover / --ds-hub-surface-hover",
  "#171f2e": "--color-hub-overlay / --ds-hub-overlay",
  "#4a90d9": "--ds-palette-blue",
  "#7b61ff": "--ds-palette-violet",
  "#e06c75": "--ds-palette-rose",
  "#98c379": "--ds-palette-green",
  "#e5c07b": "--ds-palette-amber",
  "#56b6c2": "--ds-palette-cyan",
  "#c678dd": "--ds-palette-purple",
  "#d19a66": "--ds-palette-orange",
  "#3b82f6": "--ds-blue-500 or Tailwind blue-500",
  "#60a5fa": "--ds-blue-400 or Tailwind blue-400",
  "#3d4f63": "--color-hub-node-bg / --ds-hub-surface-muted",
  "#888": "--color-text-muted / --ds-neutral-400",
  "#888888": "--color-text-muted / --ds-neutral-400",
  "#6b7280": "--color-text-muted / --ds-neutral-400",
  "#fff": "var(--background) or --color-text-inverse",
  "#ffffff": "var(--background) or --color-text-inverse",
};

const SPACING_SUGGESTIONS = {
  "60px": "--header-height (var(--ds-header-height))",
  "280px": "--flyout-width (var(--ds-flyout-width))",
  "32px": "--sidebar-strip-width (var(--ds-sidebar-strip-width))",
  "220px": "--drawer-width (var(--ds-drawer-width))",
};

// ----------------------------------------------------------------
// Detection patterns
// ----------------------------------------------------------------

function isCommentOrVarDef(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("--") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("//")
  );
}

function isJsComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

function suggestHexToken(match) {
  const lower = match.toLowerCase();
  return COLOR_HEX_SUGGESTIONS[lower] ?? "Define as token in tokens.css";
}

function suggestRgbToken() {
  return "Use a semantic color token from tokens.css";
}

function suggestArbitraryColor(match) {
  const hex = match.match(/#[0-9a-fA-F]+/)?.[0]?.toLowerCase();
  if (hex && COLOR_HEX_SUGGESTIONS[hex]) {
    const tokenName = COLOR_HEX_SUGGESTIONS[hex].split(" /")[0].split(" or")[0].trim();
    return `Use var(${tokenName})`;
  }
  return "Use a semantic Tailwind color class or var(--token)";
}

function suggestSpacing(match) {
  const px = match.match(/(\d+)px/)?.[1];
  if (px && SPACING_SUGGESTIONS[`${px}px`]) {
    return SPACING_SUGGESTIONS[`${px}px`];
  }
  return "Use a spacing token (--space-*) or Tailwind class";
}

function suggestFontSize(match) {
  const sizeMap = {
    "text-[10px]": "--ds-text-2xs (use text-[0.625rem])",
    "text-[11px]": "--ds-text-xs (use text-[0.6875rem])",
    "text-[12px]": "text-xs (Tailwind built-in)",
    "text-[13px]": "--ds-text-sm or text-xs",
    "text-[14px]": "text-sm (Tailwind built-in)",
  };
  return sizeMap[match] ?? "Use a Tailwind text size class";
}

function suggestZIndex(match) {
  const z = match.match(/\[(\d+)\]/)?.[1];
  const zMap = {
    "10": "--z-raised",
    "20": "--z-controls",
    "30": "--z-flyout",
    "40": "--z-sidebar",
    "50": "--z-modal",
    "60": "--z-toast",
  };
  return zMap[z] ?? "Use a z-index token from the scale";
}

function suggestShadow() {
  return "Use --shadow-sm/md/lg/xl/overlay/focus token";
}

const PATTERNS = [
  // ERRORS: These must be fixed
  {
    name: "hardcoded-hex-color",
    severity: "error",
    category: "color",
    regex: /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g,
    description: "Hardcoded hex color",
    cssOnly: false,
    suggest: suggestHexToken,
    skipLine: isCommentOrVarDef,
  },
  {
    name: "hardcoded-rgb-color",
    severity: "error",
    category: "color",
    regex: /(?<!var\()rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g,
    description: "Hardcoded rgb/rgba color",
    cssOnly: true,
    suggest: suggestRgbToken,
    skipLine: isCommentOrVarDef,
  },
  {
    name: "arbitrary-tailwind-color",
    severity: "error",
    category: "color",
    regex: /(?:bg|text|border|ring|outline|fill|stroke|from|to|via)-\[#[0-9a-fA-F]{3,8}\]/g,
    description: "Arbitrary Tailwind color class",
    cssOnly: false,
    suggest: suggestArbitraryColor,
    skipLine: isJsComment,
  },

  // WARNINGS: Should be fixed but not blocking
  {
    name: "hardcoded-px-in-css",
    severity: "warning",
    category: "spacing",
    regex: /(?:padding|margin|gap|top|left|right|bottom|width|height)\s*:\s*\d+px/g,
    description: "Hardcoded pixel spacing in CSS",
    cssOnly: true,
    suggest: suggestSpacing,
    skipLine: isCommentOrVarDef,
  },
  {
    name: "arbitrary-tailwind-spacing",
    severity: "warning",
    category: "spacing",
    regex: /(?:top|left|right|bottom|w|h|min-w|min-h|max-w|max-h|gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-\[\d+px\]/g,
    description: "Arbitrary Tailwind spacing",
    cssOnly: false,
    suggest: suggestSpacing,
    skipLine: isJsComment,
  },
  {
    name: "hardcoded-font-size",
    severity: "warning",
    category: "typography",
    regex: /text-\[\d+px\]/g,
    description: "Arbitrary Tailwind font size",
    cssOnly: false,
    suggest: suggestFontSize,
    skipLine: isJsComment,
  },
  {
    name: "hardcoded-z-index",
    severity: "warning",
    category: "z-index",
    regex: /z-\[\d+\]/g,
    description: "Arbitrary z-index value",
    cssOnly: false,
    suggest: suggestZIndex,
    skipLine: isJsComment,
  },
  {
    name: "hardcoded-box-shadow",
    severity: "warning",
    category: "shadow",
    regex: /box-shadow\s*:\s*[^;]+/g,
    description: "Hardcoded box-shadow in CSS",
    cssOnly: true,
    suggest: suggestShadow,
    skipLine: isCommentOrVarDef,
  },
];

// ----------------------------------------------------------------
// File scanning
// ----------------------------------------------------------------

function getAllFiles(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (SKIP_PATTERNS.some((p) => fullPath.includes(p))) {
        continue;
      }
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...getAllFiles(fullPath));
      } else if (SCAN_EXTENSIONS.has(extname(entry))) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist, skip
  }
  return results;
}

function scanFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = relative(ROOT, filePath);
  const isCss = filePath.endsWith(".css") || filePath.endsWith(".scss");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const pattern of PATTERNS) {
      if (pattern.cssOnly && !isCss) {
        continue;
      }

      if (pattern.skipLine(line)) {
        continue;
      }

      // Reset regex lastIndex for global patterns
      pattern.regex.lastIndex = 0;

      let match = pattern.regex.exec(line);
      while (match !== null) {
        violations.push({
          file: relPath,
          line: lineNum,
          column: match.index + 1,
          match: match[0],
          severity: pattern.severity,
          category: pattern.category,
          description: pattern.description,
          suggestion: pattern.suggest(match[0]),
        });
        match = pattern.regex.exec(line);
      }
    }
  }

  return violations;
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

function main() {
  const allFiles = [];
  for (const dir of SCAN_DIRS) {
    allFiles.push(...getAllFiles(join(ROOT, dir)));
  }

  // Also scan app/globals.css directly
  const globalsCss = join(ROOT, "app", "globals.css");
  if (!allFiles.includes(globalsCss)) {
    allFiles.push(globalsCss);
  }

  let errorCount = 0;
  let warningCount = 0;
  const allViolations = [];

  for (const file of allFiles) {
    const violations = scanFile(file);
    allViolations.push(...violations);
    for (const v of violations) {
      if (v.severity === "error") {
        errorCount++;
      } else {
        warningCount++;
      }
    }
  }

  // Sort by file, then line number
  allViolations.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    return a.line - b.line;
  });

  // Print results
  for (const v of allViolations) {
    if (quietMode && v.severity === "warning") {
      continue;
    }

    const icon = v.severity === "error" ? "ERROR" : "WARN";
    process.stdout.write(
      `${icon}  ${v.file}:${v.line}:${v.column}  ${v.description}: ${v.match}\n`,
    );
    process.stdout.write(`       Suggestion: ${v.suggestion}\n\n`);
  }

  // Summary
  process.stdout.write("---\n");
  process.stdout.write(
    `Token audit: ${allFiles.length} files scanned, ${errorCount} errors, ${warningCount} warnings\n`,
  );

  if (errorCount > 0) {
    process.stdout.write(
      "\nFix errors before committing. See keeperhub/specs/design-system/tokens.css for available tokens.\n",
    );
    process.exit(1);
  }

  if (warningCount > 0 && !quietMode) {
    process.stdout.write(
      "\nWarnings found. Consider migrating to design tokens for consistency.\n",
    );
  }

  process.exit(0);
}

main();
