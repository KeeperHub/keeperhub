#!/usr/bin/env tsx

/**
 * WASM Fuel Calibration Script
 *
 * Measures fuel consumption for various JavaScript operations using
 * secure-javascript-sandbox. Used to establish baselines for operation counting.
 *
 * Prerequisites:
 *   docker compose --profile profile-workflows up -d
 *
 * Usage:
 *   # Start profiling infrastructure (includes js-sandbox on port 3001)
 *   docker compose --profile profile-workflows up -d
 *   pnpm profile:calibrate
 *
 *   # Or run sandbox manually on different port
 *   docker run --rm -d -p 3002:3000 --name js-sandbox forbeslindesay/secure-js-sandbox
 *   SANDBOX_URL=http://localhost:3002 pnpm profile:calibrate
 *
 *   # Cleanup
 *   docker compose --profile profile-workflows down
 */

const SANDBOX_URL = process.env.SANDBOX_URL || "http://localhost:3001";

// ============================================================================
// Types
// ============================================================================

type EvaluateRequest = {
  code: string;
  parameters?: unknown[];
  filename?: string;
};

type EvaluateResponse = {
  success: boolean;
  result?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
  fuel_consumed?: number;
  memory_used?: number;
};

type CalibrationResult = {
  name: string;
  description: string;
  iterations: number;
  fuelConsumed: number;
  fuelPerIteration: number;
  success: boolean;
  error?: string;
};

// ============================================================================
// Test Cases
// ============================================================================

// NOTE: The sandbox expects the function to be named `fn` - it will auto-call it
const CALIBRATION_TESTS: Array<{
  name: string;
  description: string;
  iterations: number;
  code: string;
}> = [
  // Baseline - empty function
  {
    name: "baseline",
    description: "Empty function call overhead",
    iterations: 1,
    code: "function fn() { return true; }",
  },

  // Arithmetic operations
  {
    name: "arithmetic-add",
    description: "Addition operations",
    iterations: 10_000,
    code: "function fn() { let sum = 0; for (let i = 0; i < 10000; i++) { sum = sum + i; } return sum; }",
  },
  {
    name: "arithmetic-multiply",
    description: "Multiplication operations",
    iterations: 10_000,
    code: "function fn() { let product = 1; for (let i = 1; i < 10000; i++) { product = (product * i) % 1000000; } return product; }",
  },
  {
    name: "arithmetic-division",
    description: "Division operations",
    iterations: 10_000,
    code: "function fn() { let result = 1000000; for (let i = 1; i < 10000; i++) { result = result / (1 + (i % 10)); if (result < 1) result = 1000000; } return result; }",
  },

  // Property access
  {
    name: "property-read",
    description: "Object property reads",
    iterations: 10_000,
    code: "function fn() { const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 }; let sum = 0; for (let i = 0; i < 10000; i++) { sum += obj.a + obj.b + obj.c + obj.d + obj.e; } return sum; }",
  },
  {
    name: "property-write",
    description: "Object property writes",
    iterations: 10_000,
    code: "function fn() { const obj = {}; for (let i = 0; i < 10000; i++) { obj.value = i; } return obj.value; }",
  },
  {
    name: "property-dynamic",
    description: "Dynamic property access (bracket notation)",
    iterations: 10_000,
    code: `function fn() { const obj = { key0: 0, key1: 1, key2: 2, key3: 3, key4: 4 }; let sum = 0; for (let i = 0; i < 10000; i++) { sum += obj["key" + (i % 5)]; } return sum; }`,
  },

  // Array operations
  {
    name: "array-push",
    description: "Array push operations",
    iterations: 10_000,
    code: "function fn() { const arr = []; for (let i = 0; i < 10000; i++) { arr.push(i); } return arr.length; }",
  },
  {
    name: "array-index",
    description: "Array index access",
    iterations: 10_000,
    code: "function fn() { const arr = Array.from({ length: 1000 }, (_, i) => i); let sum = 0; for (let i = 0; i < 10000; i++) { sum += arr[i % 1000]; } return sum; }",
  },
  {
    name: "array-map",
    description: "Array map operation",
    iterations: 1000,
    code: "function fn() { const arr = Array.from({ length: 1000 }, (_, i) => i); return arr.map(x => x * 2).reduce((a, b) => a + b, 0); }",
  },

  // Function calls
  {
    name: "function-call-simple",
    description: "Simple function calls",
    iterations: 10_000,
    code: "function fn() { function add(a, b) { return a + b; } let sum = 0; for (let i = 0; i < 10000; i++) { sum = add(sum, i); } return sum; }",
  },
  {
    name: "function-call-recursive",
    description: "Recursive function calls (fibonacci)",
    iterations: 25,
    code: "function fn() { function fib(n) { if (n <= 1) return n; return fib(n - 1) + fib(n - 2); } return fib(25); }",
  },

  // String operations
  {
    name: "string-concat",
    description: "String concatenation",
    iterations: 1000,
    code: `function fn() { let str = ""; for (let i = 0; i < 1000; i++) { str += "x"; } return str.length; }`,
  },
  {
    name: "string-template",
    description: "Template literal operations",
    iterations: 1000,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Code string intentionally contains template literal syntax
    code: 'function fn() { let result = ""; for (let i = 0; i < 1000; i++) { result = `value: ${i}, prev: ${result.length}`; } return result.length; }',
  },

  // Object creation
  {
    name: "object-create",
    description: "Object literal creation",
    iterations: 1000,
    code: `function fn() { const objects = []; for (let i = 0; i < 1000; i++) { objects.push({ id: i, name: "test", value: i * 2 }); } return objects.length; }`,
  },

  // JSON operations
  {
    name: "json-stringify",
    description: "JSON.stringify operations",
    iterations: 1000,
    code: `function fn() { const obj = { a: 1, b: "test", c: [1, 2, 3], d: { nested: true } }; let totalLength = 0; for (let i = 0; i < 1000; i++) { totalLength += JSON.stringify(obj).length; } return totalLength; }`,
  },
  {
    name: "json-parse",
    description: "JSON.parse operations",
    iterations: 1000,
    code: `function fn() { const json = '{"a":1,"b":"test","c":[1,2,3],"d":{"nested":true}}'; let sum = 0; for (let i = 0; i < 1000; i++) { sum += JSON.parse(json).a; } return sum; }`,
  },

  // Comparison operations
  {
    name: "comparison-numeric",
    description: "Numeric comparisons",
    iterations: 10_000,
    code: "function fn() { let count = 0; for (let i = 0; i < 10000; i++) { if (i > 5000) count++; if (i < 2500) count++; if (i === 7500) count++; } return count; }",
  },

  // Logical operations
  {
    name: "logical-and-or",
    description: "Logical AND/OR operations",
    iterations: 10_000,
    code: "function fn() { let count = 0; for (let i = 0; i < 10000; i++) { if (i > 1000 && i < 9000) count++; if (i < 500 || i > 9500) count++; } return count; }",
  },

  // Complex scenario - simulating workflow step
  {
    name: "workflow-simulation",
    description: "Simulated workflow step (object manipulation + JSON)",
    iterations: 100,
    code: `function fn() { const results = []; for (let i = 0; i < 100; i++) { const input = { id: i, data: { value: i * 10, tags: ["a", "b", "c"] } }; const processed = JSON.parse(JSON.stringify(input)); processed.data.value *= 2; processed.data.tags.push("processed"); processed.timestamp = Date.now(); results.push(processed); } return results.length; }`,
  },
];

// ============================================================================
// API Client
// ============================================================================

async function evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
  const payload = {
    ...request,
    parameters: request.parameters ?? [],
  };

  const response = await fetch(`${SANDBOX_URL}/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Sandbox request failed: ${response.status}`);
  }

  return response.json();
}

async function checkSandboxHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${SANDBOX_URL}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "function test() { return 1; }",
        parameters: [],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// Calibration Runner
// ============================================================================

async function runCalibration(
  test: (typeof CALIBRATION_TESTS)[0]
): Promise<CalibrationResult> {
  try {
    const response = await evaluate({
      code: test.code,
      filename: `${test.name}.js`,
    });

    if (!response.success) {
      return {
        name: test.name,
        description: test.description,
        iterations: test.iterations,
        fuelConsumed: 0,
        fuelPerIteration: 0,
        success: false,
        error: response.error || "Unknown error",
      };
    }

    const fuelConsumed = response.fuel_consumed || 0;

    return {
      name: test.name,
      description: test.description,
      iterations: test.iterations,
      fuelConsumed,
      fuelPerIteration: fuelConsumed / test.iterations,
      success: true,
    };
  } catch (error) {
    return {
      name: test.name,
      description: test.description,
      iterations: test.iterations,
      fuelConsumed: 0,
      fuelPerIteration: 0,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================================================
// Output Formatting
// ============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Report formatting has many branches for categories
function formatResults(results: CalibrationResult[]): string {
  const lines: string[] = [];

  lines.push(`\n${"=".repeat(80)}`);
  lines.push("WASM FUEL CALIBRATION RESULTS");
  lines.push("=".repeat(80));

  // Get baseline for comparison
  const baseline = results.find((r) => r.name === "baseline");
  const baselineFuel = baseline?.fuelConsumed || 0;

  lines.push(
    `\nBaseline (empty function): ${baselineFuel.toLocaleString()} fuel\n`
  );

  // Group by category
  const categories: Record<string, CalibrationResult[]> = {
    arithmetic: [],
    property: [],
    array: [],
    function: [],
    string: [],
    object: [],
    json: [],
    comparison: [],
    workflow: [],
  };

  for (const result of results) {
    if (result.name === "baseline") {
      continue;
    }

    const category = result.name.split("-")[0];
    if (categories[category]) {
      categories[category].push(result);
    } else {
      categories.workflow.push(result);
    }
  }

  for (const [category, categoryResults] of Object.entries(categories)) {
    if (categoryResults.length === 0) {
      continue;
    }

    lines.push(`\n${"─".repeat(80)}`);
    lines.push(`${category.toUpperCase()} OPERATIONS`);
    lines.push("─".repeat(80));
    lines.push(
      `${"Test".padEnd(25)} ${"Iterations".padStart(12)} ${"Total Fuel".padStart(15)} ${"Fuel/Op".padStart(12)} ${"Status".padStart(10)}`
    );
    lines.push("-".repeat(80));

    for (const result of categoryResults) {
      const status = result.success ? "OK" : "FAIL";
      const fuelPerOp = result.success
        ? result.fuelPerIteration.toFixed(1)
        : "N/A";

      lines.push(
        `${result.name.padEnd(25)} ${result.iterations.toLocaleString().padStart(12)} ${result.fuelConsumed.toLocaleString().padStart(15)} ${fuelPerOp.padStart(12)} ${status.padStart(10)}`
      );

      if (!result.success && result.error) {
        lines.push(`  └─ Error: ${result.error}`);
      }
    }
  }

  // Summary statistics
  const successful = results.filter((r) => r.success && r.name !== "baseline");

  if (successful.length > 0) {
    lines.push(`\n${"=".repeat(80)}`);
    lines.push("SUMMARY STATISTICS");
    lines.push("=".repeat(80));

    const sorted = [...successful].sort(
      (a, b) => b.fuelPerIteration - a.fuelPerIteration
    );

    lines.push("\nMost expensive operations (fuel per iteration):");
    for (const result of sorted.slice(0, 5)) {
      lines.push(
        `  ${result.name.padEnd(30)} ${result.fuelPerIteration.toFixed(1).padStart(12)} fuel/op`
      );
    }

    lines.push("\nLeast expensive operations (fuel per iteration):");
    for (const result of sorted.slice(-5).reverse()) {
      lines.push(
        `  ${result.name.padEnd(30)} ${result.fuelPerIteration.toFixed(1).padStart(12)} fuel/op`
      );
    }

    // Calculate recommended fuel budgets
    const avgFuelPerOp =
      successful.reduce((sum, r) => sum + r.fuelPerIteration, 0) /
      successful.length;

    lines.push(`\n${"─".repeat(80)}`);
    lines.push("RECOMMENDED FUEL BUDGETS");
    lines.push("─".repeat(80));
    lines.push(`Average fuel per operation: ${avgFuelPerOp.toFixed(1)}`);
    lines.push("");
    lines.push("Estimated budgets for operation counts:");
    lines.push(
      `  1,000 ops:     ${(avgFuelPerOp * 1000).toLocaleString()} fuel`
    );
    lines.push(
      `  10,000 ops:    ${(avgFuelPerOp * 10_000).toLocaleString()} fuel`
    );
    lines.push(
      `  100,000 ops:   ${(avgFuelPerOp * 100_000).toLocaleString()} fuel`
    );
    lines.push(
      `  1,000,000 ops: ${(avgFuelPerOp * 1_000_000).toLocaleString()} fuel`
    );
  }

  lines.push(`\n${"=".repeat(80)}`);

  return lines.join("\n");
}

function formatJSON(results: CalibrationResult[]): string {
  const summary = {
    timestamp: new Date().toISOString(),
    sandboxUrl: SANDBOX_URL,
    testCount: results.length,
    successCount: results.filter((r) => r.success).length,
    results: results.map((r) => ({
      name: r.name,
      description: r.description,
      iterations: r.iterations,
      fuelConsumed: r.fuelConsumed,
      fuelPerIteration: r.fuelPerIteration,
      success: r.success,
      error: r.error,
    })),
    statistics: {
      baseline: results.find((r) => r.name === "baseline")?.fuelConsumed || 0,
      avgFuelPerIteration:
        results
          .filter((r) => r.success && r.name !== "baseline")
          .reduce((sum, r) => sum + r.fuelPerIteration, 0) /
        results.filter((r) => r.success && r.name !== "baseline").length,
    },
  };

  return JSON.stringify(summary, null, 2);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("\n🔬 WASM Fuel Calibration");
  console.log("=".repeat(40));
  console.log(`Sandbox URL: ${SANDBOX_URL}`);

  // Check sandbox is running
  console.log("\nChecking sandbox health...");
  const healthy = await checkSandboxHealth();

  if (!healthy) {
    console.error("\n❌ Sandbox is not available!");
    console.error("\nTo start the sandbox:");
    console.error(
      "  docker run --rm -d -p 3000:3000 --name js-sandbox forbeslindesay/secure-js-sandbox"
    );
    console.error("\nThen re-run this script.");
    process.exit(1);
  }

  console.log("✓ Sandbox is healthy\n");

  // Run calibration tests
  const results: CalibrationResult[] = [];

  for (const test of CALIBRATION_TESTS) {
    process.stdout.write(`Running ${test.name}...`);
    const result = await runCalibration(test);
    results.push(result);

    if (result.success) {
      console.log(` ${result.fuelConsumed.toLocaleString()} fuel`);
    } else {
      console.log(` FAILED: ${result.error}`);
    }
  }

  // Output results
  const args = process.argv.slice(2);
  if (args.includes("--json")) {
    console.log(formatJSON(results));
  } else {
    console.log(formatResults(results));
  }

  // Save to file if requested
  const outputArg = args.find((a) => a.startsWith("--output="));
  if (outputArg) {
    const outputPath = outputArg.split("=")[1];
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputPath, formatJSON(results));
    console.log(`\nResults saved to ${outputPath}`);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

export {};
