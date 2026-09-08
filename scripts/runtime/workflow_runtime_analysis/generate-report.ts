#!/usr/bin/env tsx

/**
 * Unified Profiling Report Generator
 *
 * Runs all profiling tools and generates a comprehensive report.
 * Presents data without opinions - developers make their own decisions.
 *
 * Usage:
 *   pnpm profile:report
 *   pnpm profile:report --json
 *   pnpm profile:report --output /tmp/report.json
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");

// ============================================================================
// Constants
// ============================================================================

const STEP_PROFILE_REGEX = /^(\S+\/\S+)\s+(\d+)\s+(\d+)\s+([\d.]+)ms/;
const CALIBRATION_FUEL_REGEX = /Running (\S+)\.\.\. ([\d,]+) fuel/;

// ============================================================================
// Types
// ============================================================================

type StepAnalysis = {
  pluginName: string;
  stepName: string;
  lines: number;
  cyclomaticComplexity: number;
  awaitExpressions: number;
  externalCalls: Array<{ name: string; type: string; line: number }>;
  tryCatchBlocks: number;
  loops: number;
};

type StaticAnalysis = {
  totalSteps: number;
  summary: {
    avgCyclomaticComplexity: number;
    avgAwaitExpressions: number;
    avgExternalCalls: number;
    mostComplex: string;
    leastComplex: string;
  };
  plugins: Record<string, StepAnalysis[]>;
};

type StepProfile = {
  step: string;
  hits: number;
  samples: number;
  duration: number;
};

type CalibrationResult = {
  name: string;
  iterations: number;
  fuelConsumed: number;
  fuelPerOp: number;
  status: string;
};

type Report = {
  timestamp: string;
  staticAnalysis: StaticAnalysis | null;
  stepProfiles: StepProfile[];
  calibration: CalibrationResult[];
  costTiers: {
    light: string[];
    medium: string[];
    heavy: string[];
  };
};

// ============================================================================
// Helpers
// ============================================================================

function runCommand(cmd: string): string {
  try {
    return execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch {
    return "";
  }
}

function parseJSON<T>(output: string): T | null {
  if (!output) {
    return null;
  }
  try {
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) {
      return null;
    }
    return JSON.parse(output.slice(jsonStart));
  } catch {
    return null;
  }
}

// ============================================================================
// Data Collection
// ============================================================================

function collectStaticAnalysis(): StaticAnalysis | null {
  const output = runCommand("pnpm profile:analyze --json 2>/dev/null");
  return parseJSON<StaticAnalysis>(output);
}

function collectStepProfiles(): StepProfile[] {
  const output = runCommand("pnpm profile:step -- --all --dry-run 2>&1");
  const profiles: StepProfile[] = [];

  for (const line of output.split("\n")) {
    const match = line.match(STEP_PROFILE_REGEX);
    if (match) {
      profiles.push({
        step: match[1],
        hits: Number.parseInt(match[2], 10),
        samples: Number.parseInt(match[3], 10),
        duration: Number.parseFloat(match[4]),
      });
    }
  }

  return profiles;
}

function collectCalibration(): CalibrationResult[] {
  // Check if sandbox is available
  const healthCheck = runCommand(
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/health 2>/dev/null"
  );
  if (healthCheck.trim() !== "200") {
    return [];
  }

  const output = runCommand("pnpm profile:calibrate 2>&1");
  const results: CalibrationResult[] = [];

  // Parse calibration output - look for lines with fuel data
  const lines = output.split("\n");
  for (const line of lines) {
    // Match: "Running arithmetic-add... 8,558,701 fuel"
    const runMatch = line.match(CALIBRATION_FUEL_REGEX);
    if (runMatch) {
      const name = runMatch[1];
      const fuel = Number.parseInt(runMatch[2].replace(/,/g, ""), 10);
      results.push({
        name,
        iterations: 0, // Will be filled from detailed output
        fuelConsumed: fuel,
        fuelPerOp: 0,
        status: "ok",
      });
    }
  }

  return results;
}

function categorizeByCost(profiles: StepProfile[]): Report["costTiers"] {
  const tiers = {
    light: [] as string[],
    medium: [] as string[],
    heavy: [] as string[],
  };

  for (const p of profiles) {
    if (p.hits < 20) {
      tiers.light.push(p.step);
    } else if (p.hits < 100) {
      tiers.medium.push(p.step);
    } else {
      tiers.heavy.push(p.step);
    }
  }

  return tiers;
}

// ============================================================================
// Report Generation
// ============================================================================

function printHeader(title: string) {
  console.log();
  console.log("═".repeat(70));
  console.log(title);
  console.log("═".repeat(70));
}

function printSection(title: string) {
  console.log();
  console.log(`── ${title} ${"─".repeat(Math.max(0, 64 - title.length))}`);
}

function printTable(headers: string[], rows: string[][], colWidths: number[]) {
  // Header
  let headerLine = "";
  for (let i = 0; i < headers.length; i++) {
    headerLine += headers[i].padEnd(colWidths[i]);
  }
  console.log(headerLine);
  console.log("-".repeat(colWidths.reduce((a, b) => a + b, 0)));

  // Rows
  for (const row of rows) {
    let line = "";
    for (let i = 0; i < row.length; i++) {
      line += row[i].padEnd(colWidths[i]);
    }
    console.log(line);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Report generation has many conditional branches for formatting
function generateReport(isJsonOutput: boolean, outputFilePath: string | null) {
  if (!isJsonOutput) {
    console.log(
      "╔══════════════════════════════════════════════════════════════════╗"
    );
    console.log(
      "║              WORKFLOW PROFILING REPORT                           ║"
    );
    console.log(
      "╚══════════════════════════════════════════════════════════════════╝"
    );
    console.log();
    console.log("Collecting data...");
  }

  // Collect all data
  const staticAnalysis = collectStaticAnalysis();
  if (!isJsonOutput && staticAnalysis) {
    console.log(`  ✓ Static analysis: ${staticAnalysis.totalSteps} steps`);
  }

  const stepProfiles = collectStepProfiles();
  if (!isJsonOutput) {
    console.log(`  ✓ Step profiling: ${stepProfiles.length} steps`);
  }

  const calibration = collectCalibration();
  if (!isJsonOutput) {
    if (calibration.length > 0) {
      console.log(`  ✓ WASM calibration: ${calibration.length} operations`);
    } else {
      console.log("  ⚠ WASM calibration: sandbox not available");
    }
  }

  const costTiers = categorizeByCost(stepProfiles);

  const report: Report = {
    timestamp: new Date().toISOString(),
    staticAnalysis,
    stepProfiles,
    calibration,
    costTiers,
  };

  // JSON output mode
  if (isJsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STATIC ANALYSIS
  // ──────────────────────────────────────────────────────────────────────────

  if (staticAnalysis) {
    printHeader("STATIC ANALYSIS (AST)");

    printSection("Summary");
    console.log(`  Total steps analyzed:     ${staticAnalysis.totalSteps}`);
    console.log(
      `  Avg cyclomatic complexity: ${staticAnalysis.summary.avgCyclomaticComplexity.toFixed(1)}`
    );
    console.log(
      `  Avg await expressions:     ${staticAnalysis.summary.avgAwaitExpressions.toFixed(1)}`
    );
    console.log(
      `  Avg external calls:        ${staticAnalysis.summary.avgExternalCalls.toFixed(1)}`
    );
    console.log(
      `  Most complex step:         ${staticAnalysis.summary.mostComplex}`
    );
    console.log(
      `  Least complex step:        ${staticAnalysis.summary.leastComplex}`
    );

    printSection("By Plugin");
    const pluginRows: string[][] = [];
    for (const [plugin, steps] of Object.entries(staticAnalysis.plugins)) {
      const avgComplexity =
        steps.reduce((sum, s) => sum + s.cyclomaticComplexity, 0) /
        steps.length;
      const totalLines = steps.reduce((sum, s) => sum + s.lines, 0);
      pluginRows.push([
        plugin,
        steps.length.toString(),
        totalLines.toString(),
        avgComplexity.toFixed(1),
      ]);
    }
    pluginRows.sort(
      (a, b) => Number.parseFloat(b[3]) - Number.parseFloat(a[3])
    );
    printTable(
      ["Plugin", "Steps", "Lines", "Avg Complexity"],
      pluginRows,
      [20, 10, 10, 16]
    );

    printSection("Step Details (sorted by complexity)");
    const stepRows: string[][] = [];
    for (const steps of Object.values(staticAnalysis.plugins)) {
      for (const step of steps) {
        stepRows.push([
          `${step.pluginName}/${step.stepName}`,
          step.cyclomaticComplexity.toString(),
          step.awaitExpressions.toString(),
          step.externalCalls.length.toString(),
          step.lines.toString(),
        ]);
      }
    }
    stepRows.sort(
      (a, b) => Number.parseInt(b[1], 10) - Number.parseInt(a[1], 10)
    );
    printTable(
      ["Step", "Complexity", "Awaits", "External", "Lines"],
      stepRows.slice(0, 15),
      [35, 12, 10, 10, 10]
    );
    if (stepRows.length > 15) {
      console.log(`  ... and ${stepRows.length - 15} more steps`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RUNTIME PROFILING
  // ──────────────────────────────────────────────────────────────────────────

  if (stepProfiles.length > 0) {
    printHeader("RUNTIME PROFILING (V8 CPU Sampling)");

    printSection("Step Load Times (dry-run, module loading only)");
    const profileRows = stepProfiles
      .sort((a, b) => b.duration - a.duration)
      .map((p) => [
        p.step,
        p.hits.toString(),
        p.samples.toString(),
        `${p.duration.toFixed(2)}ms`,
      ]);
    printTable(
      ["Step", "Hits", "Samples", "Duration"],
      profileRows,
      [35, 10, 10, 15]
    );

    printSection("Cost Tiers (based on function hits)");
    console.log(
      `  Light  (<20 hits):   ${costTiers.light.join(", ") || "(none)"}`
    );
    console.log(
      `  Medium (20-100):     ${costTiers.medium.join(", ") || "(none)"}`
    );
    console.log(
      `  Heavy  (>100 hits):  ${costTiers.heavy.join(", ") || "(none)"}`
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WASM CALIBRATION
  // ──────────────────────────────────────────────────────────────────────────

  if (calibration.length > 0) {
    printHeader("WASM FUEL CALIBRATION");

    printSection("Fuel Consumption by Operation");
    const calibrationRows = calibration
      .filter((c) => c.fuelConsumed > 0)
      .sort((a, b) => b.fuelConsumed - a.fuelConsumed)
      .slice(0, 15)
      .map((c) => [c.name, c.fuelConsumed.toLocaleString()]);
    printTable(["Operation", "Fuel Consumed"], calibrationRows, [35, 20]);
  } else {
    printHeader("WASM FUEL CALIBRATION");
    console.log();
    console.log("  Sandbox not available. To run calibration:");
    console.log("    docker compose --profile profile-workflows up -d");
    console.log("    pnpm profile:calibrate");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CROSS-REFERENCE
  // ──────────────────────────────────────────────────────────────────────────

  if (staticAnalysis && stepProfiles.length > 0) {
    printHeader("CROSS-REFERENCE: STATIC vs RUNTIME");

    printSection("Complexity vs Load Time");
    const crossRef: string[][] = [];
    for (const profile of stepProfiles) {
      const [plugin, step] = profile.step.split("/");
      const staticStep = staticAnalysis.plugins[plugin]?.find(
        (s) => s.stepName === step
      );
      if (staticStep) {
        crossRef.push([
          profile.step,
          staticStep.cyclomaticComplexity.toString(),
          profile.hits.toString(),
          `${profile.duration.toFixed(2)}ms`,
        ]);
      }
    }
    crossRef.sort(
      (a, b) => Number.parseInt(b[2], 10) - Number.parseInt(a[2], 10)
    );
    printTable(
      ["Step", "Static Complexity", "Runtime Hits", "Load Time"],
      crossRef,
      [30, 18, 14, 12]
    );

    console.log();
    console.log(
      "  Note: Static complexity does not correlate with runtime cost."
    );
    console.log(
      "  Runtime cost is dominated by dependencies, not application code."
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // REFERENCE DATA (from docs)
  // ──────────────────────────────────────────────────────────────────────────

  printHeader("REFERENCE: DOCUMENTED BASELINES");

  printSection("Expected Function Calls (Precise Mode)");
  printTable(
    ["Step Category", "Function Calls", "Relative Cost"],
    [
      ["Light (webhook, resend)", "~5,000", "1x"],
      ["Medium (slack, discord)", "~150,000", "30x"],
      ["Heavy (web3/*)", "~215,000", "40x"],
    ],
    [25, 18, 15]
  );

  printSection("Workflow Execution Breakdown");
  printTable(
    ["Category", "% of Function Calls"],
    [
      ["Database (Drizzle ORM)", "51.7%"],
      ["Node internals", "47.6%"],
      ["Workflow executor", "0.1%"],
      ["Step functions", "0.1%"],
    ],
    [30, 22]
  );

  printSection("WASM Fuel Reference");
  printTable(
    ["Operation", "Fuel/Op"],
    [
      ["Addition", "856"],
      ["Multiplication", "1,055"],
      ["Property read", "3,525"],
      ["Function call", "2,974"],
      ["JSON.stringify", "12,044"],
      ["Workflow simulation", "44,845"],
    ],
    [25, 15]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // FOOTER
  // ──────────────────────────────────────────────────────────────────────────

  console.log();
  console.log("═".repeat(70));
  console.log("For detailed analysis:");
  console.log("  pnpm profile:analyze --verbose        # Full AST breakdown");
  console.log(
    "  pnpm profile:step --step <n> --precise # Exact function counts"
  );
  console.log(
    "  pnpm profile:workflow                 # Full execution profile"
  );
  console.log("  pnpm profile:calibrate                # WASM fuel details");
  console.log("═".repeat(70));

  // Save to file if requested
  if (outputFilePath) {
    writeFileSync(outputFilePath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${outputFilePath}`);
  }
}

// ============================================================================
// Main
// ============================================================================

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;

generateReport(jsonOutput, outputPath);
