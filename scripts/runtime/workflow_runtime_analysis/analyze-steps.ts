#!/usr/bin/env tsx

/**
 * Step Function Analyzer
 *
 * Analyzes step functions to evaluate complexity and operation counts.
 * Uses TypeScript Compiler API for AST analysis.
 *
 * Metrics analyzed:
 * - Async operations (await expressions)
 * - Function calls (external API calls, DB queries, etc.)
 * - Branching complexity (if/else, ternary, switch)
 * - Error handling (try/catch/throw)
 * - Loops (for, while, do-while)
 * - Cyclomatic complexity
 *
 * Usage:
 *   pnpm tsx scripts/analyze-steps.ts                    # Analyze all steps
 *   pnpm tsx scripts/analyze-steps.ts --plugin slack     # Analyze specific plugin
 *   pnpm tsx scripts/analyze-steps.ts --json             # Output as JSON
 *   pnpm tsx scripts/analyze-steps.ts --verbose          # Show detailed breakdown
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// Directories to scan for plugins
const PLUGINS_DIR = join(process.cwd(), "plugins");
const KEEPERHUB_PLUGINS_DIR = join(process.cwd(), "keeperhub", "plugins");

type OperationMetrics = {
  file: string;
  pluginName: string;
  stepName: string;
  lines: number;
  awaitExpressions: number;
  functionCalls: number;
  externalCalls: ExternalCall[];
  conditionals: number;
  tryCatchBlocks: number;
  throwStatements: number;
  loops: number;
  cyclomaticComplexity: number;
  // Detailed breakdown
  details: {
    ifs: number;
    ternaries: number;
    switches: number;
    switchCases: number;
    forLoops: number;
    whileLoops: number;
    doWhileLoops: number;
    logicalAnds: number;
    logicalOrs: number;
  };
};

type ExternalCall = {
  name: string;
  type: "fetch" | "db" | "sdk" | "unknown";
  line: number;
};

type AnalysisResult = {
  totalSteps: number;
  plugins: Record<string, OperationMetrics[]>;
  summary: {
    avgAwaitExpressions: number;
    avgCyclomaticComplexity: number;
    avgExternalCalls: number;
    mostComplex: string;
    leastComplex: string;
  };
};

/**
 * Find all step files in a plugin directory
 */
function findStepFiles(pluginDir: string): string[] {
  const stepsDir = join(pluginDir, "steps");
  if (!statSync(stepsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }

  return readdirSync(stepsDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(stepsDir, f));
}

/**
 * Get all plugin directories
 */
function getPluginDirectories(baseDir: string): string[] {
  if (!statSync(baseDir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }

  return readdirSync(baseDir)
    .filter((name) => {
      const fullPath = join(baseDir, name);
      return (
        statSync(fullPath).isDirectory() &&
        !name.startsWith(".") &&
        name !== "node_modules"
      );
    })
    .map((name) => join(baseDir, name));
}

/**
 * Analyze a TypeScript source file for operation metrics
 */
function analyzeFile(filePath: string): OperationMetrics {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
  });

  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) {
    throw new Error(`Could not parse file: ${filePath}`);
  }

  const pathParts = filePath.split("/");
  const stepsIndex = pathParts.indexOf("steps");
  const pluginName = stepsIndex > 0 ? pathParts[stepsIndex - 1] : "unknown";
  const stepName = (pathParts.at(-1) ?? "unknown").replace(".ts", "");

  const metrics: OperationMetrics = {
    file: relative(process.cwd(), filePath),
    pluginName,
    stepName,
    lines:
      sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1,
    awaitExpressions: 0,
    functionCalls: 0,
    externalCalls: [],
    conditionals: 0,
    tryCatchBlocks: 0,
    throwStatements: 0,
    loops: 0,
    cyclomaticComplexity: 1, // Base complexity
    details: {
      ifs: 0,
      ternaries: 0,
      switches: 0,
      switchCases: 0,
      forLoops: 0,
      whileLoops: 0,
      doWhileLoops: 0,
      logicalAnds: 0,
      logicalOrs: 0,
    },
  };

  // Known external call patterns
  const externalPatterns: Record<string, ExternalCall["type"]> = {
    fetch: "fetch",
    "db.": "db",
    "db.select": "db",
    "db.insert": "db",
    "db.update": "db",
    "db.delete": "db",
    "signer.": "sdk",
    "ethers.": "sdk",
    initializeParaSigner: "sdk",
    fetchCredentials: "sdk",
    resolveRpcConfig: "sdk",
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: AST visitor pattern requires checking many node types
  function visit(node: ts.Node) {
    // Await expressions
    if (ts.isAwaitExpression(node)) {
      metrics.awaitExpressions += 1;
    }

    // Function calls
    if (ts.isCallExpression(node)) {
      metrics.functionCalls += 1;

      // Check for external calls
      try {
        // biome-ignore lint/style/noNonNullAssertion: sourceFile is validated at function entry
        const callText = node.expression.getText(sourceFile!);
        for (const [pattern, type] of Object.entries(externalPatterns)) {
          if (callText.includes(pattern) || callText.startsWith(pattern)) {
            // biome-ignore lint/style/noNonNullAssertion: sourceFile is validated at function entry
            const pos = node.getStart(sourceFile!);
            // biome-ignore lint/style/noNonNullAssertion: sourceFile is validated at function entry
            const { line } = sourceFile!.getLineAndCharacterOfPosition(pos);
            metrics.externalCalls.push({
              name: callText,
              type,
              line: line + 1,
            });
            break;
          }
        }
      } catch {
        // Skip if can't get text (synthetic nodes)
      }
    }

    // If statements
    if (ts.isIfStatement(node)) {
      metrics.details.ifs += 1;
      metrics.conditionals += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // Ternary expressions
    if (ts.isConditionalExpression(node)) {
      metrics.details.ternaries += 1;
      metrics.conditionals += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // Switch statements
    if (ts.isSwitchStatement(node)) {
      metrics.details.switches += 1;
      metrics.conditionals += 1;
    }

    // Switch cases (each adds to complexity)
    if (ts.isCaseClause(node)) {
      metrics.details.switchCases += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // Try-catch blocks
    if (ts.isTryStatement(node)) {
      metrics.tryCatchBlocks += 1;
    }

    // Catch clauses add to complexity
    if (ts.isCatchClause(node)) {
      metrics.cyclomaticComplexity += 1;
    }

    // Throw statements
    if (ts.isThrowStatement(node)) {
      metrics.throwStatements += 1;
    }

    // For loops
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      metrics.details.forLoops += 1;
      metrics.loops += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // While loops
    if (ts.isWhileStatement(node)) {
      metrics.details.whileLoops += 1;
      metrics.loops += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // Do-while loops
    if (ts.isDoStatement(node)) {
      metrics.details.doWhileLoops += 1;
      metrics.loops += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // Logical AND (&&) - adds decision point
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      metrics.details.logicalAnds += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // Logical OR (||) - adds decision point
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      metrics.details.logicalOrs += 1;
      metrics.cyclomaticComplexity += 1;
    }

    // Nullish coalescing (??) - adds decision point
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      metrics.cyclomaticComplexity += 1;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return metrics;
}

/**
 * Format metrics for console output
 */
function formatMetrics(metrics: OperationMetrics, verbose: boolean): string {
  const lines: string[] = [];

  lines.push(`\n  ${metrics.stepName}`);
  lines.push(`    Lines: ${metrics.lines}`);
  lines.push(`    Await expressions: ${metrics.awaitExpressions}`);
  lines.push(`    External calls: ${metrics.externalCalls.length}`);
  lines.push(`    Conditionals: ${metrics.conditionals}`);
  lines.push(`    Try-catch blocks: ${metrics.tryCatchBlocks}`);
  lines.push(`    Loops: ${metrics.loops}`);
  lines.push(`    Cyclomatic complexity: ${metrics.cyclomaticComplexity}`);

  if (verbose) {
    lines.push("    --- Details ---");
    lines.push(`    If statements: ${metrics.details.ifs}`);
    lines.push(`    Ternary expressions: ${metrics.details.ternaries}`);
    lines.push(`    Switch statements: ${metrics.details.switches}`);
    lines.push(`    Switch cases: ${metrics.details.switchCases}`);
    lines.push(`    For loops: ${metrics.details.forLoops}`);
    lines.push(`    While loops: ${metrics.details.whileLoops}`);
    lines.push(`    Logical ANDs: ${metrics.details.logicalAnds}`);
    lines.push(`    Logical ORs: ${metrics.details.logicalOrs}`);

    if (metrics.externalCalls.length > 0) {
      lines.push("    --- External Calls ---");
      for (const call of metrics.externalCalls) {
        lines.push(`    [${call.type}] ${call.name} (line ${call.line})`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Main analysis function
 */
function analyzeSteps(options: {
  plugin?: string;
  json?: boolean;
  verbose?: boolean;
}): AnalysisResult {
  const result: AnalysisResult = {
    totalSteps: 0,
    plugins: {},
    summary: {
      avgAwaitExpressions: 0,
      avgCyclomaticComplexity: 0,
      avgExternalCalls: 0,
      mostComplex: "",
      leastComplex: "",
    },
  };

  const allMetrics: OperationMetrics[] = [];

  // Collect all plugin directories
  const pluginDirs = [
    ...getPluginDirectories(PLUGINS_DIR),
    ...getPluginDirectories(KEEPERHUB_PLUGINS_DIR),
  ];

  for (const pluginDir of pluginDirs) {
    const pluginName = pluginDir.split("/").pop() || "unknown";

    // Filter by plugin name if specified
    if (options.plugin && pluginName !== options.plugin) {
      continue;
    }

    const stepFiles = findStepFiles(pluginDir);

    if (stepFiles.length === 0) {
      continue;
    }

    result.plugins[pluginName] = [];

    for (const stepFile of stepFiles) {
      try {
        const metrics = analyzeFile(stepFile);
        result.plugins[pluginName].push(metrics);
        allMetrics.push(metrics);
        result.totalSteps += 1;
      } catch (error) {
        console.error(`Error analyzing ${stepFile}:`, error);
      }
    }
  }

  // Calculate summary
  if (allMetrics.length > 0) {
    result.summary.avgAwaitExpressions =
      allMetrics.reduce((sum, m) => sum + m.awaitExpressions, 0) /
      allMetrics.length;
    result.summary.avgCyclomaticComplexity =
      allMetrics.reduce((sum, m) => sum + m.cyclomaticComplexity, 0) /
      allMetrics.length;
    result.summary.avgExternalCalls =
      allMetrics.reduce((sum, m) => sum + m.externalCalls.length, 0) /
      allMetrics.length;

    const sorted = [...allMetrics].sort(
      (a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity
    );
    result.summary.mostComplex = `${sorted[0].pluginName}/${sorted[0].stepName}`;
    // biome-ignore lint/style/noNonNullAssertion: array is guaranteed non-empty by containing if block
    const last = sorted.at(-1)!;
    result.summary.leastComplex = `${last.pluginName}/${last.stepName}`;
  }

  return result;
}

// CLI
const args = process.argv.slice(2);
const cliOptions = {
  plugin:
    args.find((a) => a.startsWith("--plugin="))?.split("=")[1] ||
    (args.includes("--plugin")
      ? args[args.indexOf("--plugin") + 1]
      : undefined),
  json: args.includes("--json"),
  verbose: args.includes("--verbose") || args.includes("-v"),
};

const result = analyzeSteps(cliOptions);

if (cliOptions.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("\n=== Step Function Analysis ===\n");
  console.log(`Total steps analyzed: ${result.totalSteps}`);

  for (const [pluginName, metrics] of Object.entries(result.plugins)) {
    console.log(`\n📦 ${pluginName}`);
    for (const m of metrics) {
      console.log(formatMetrics(m, cliOptions.verbose));
    }
  }

  console.log("\n=== Summary ===");
  console.log(
    `Average await expressions: ${result.summary.avgAwaitExpressions.toFixed(1)}`
  );
  console.log(
    `Average cyclomatic complexity: ${result.summary.avgCyclomaticComplexity.toFixed(1)}`
  );
  console.log(
    `Average external calls: ${result.summary.avgExternalCalls.toFixed(1)}`
  );
  console.log(`Most complex: ${result.summary.mostComplex}`);
  console.log(`Least complex: ${result.summary.leastComplex}`);
  console.log("");
}
