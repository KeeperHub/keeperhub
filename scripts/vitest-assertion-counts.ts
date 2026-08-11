/**
 * Shared executed/skipped classification for vitest JSON reporter output.
 *
 * Both the coverage floor (scripts/protocol-coverage-floor.ts) and the
 * coverage report (scripts/protocol-coverage-report.ts) decide "did a test
 * actually run" from assertion statuses; keeping one definition prevents the
 * two from drifting. The floor script runs in CI with nothing installed
 * beyond node builtins, so this module must stay dependency-free.
 */

export type VitestAssertionCounts = {
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
};

export type VitestJsonResults = {
  testResults?: Array<{
    name?: string;
    startTime?: number;
    endTime?: number;
    assertionResults?: Array<{ status: string }>;
  }>;
};

export function countAssertions(
  assertionResults: Array<{ status: string }> | undefined
): VitestAssertionCounts {
  const counts: VitestAssertionCounts = {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const a of assertionResults ?? []) {
    if (a.status === "passed") {
      counts.passed += 1;
      counts.executed += 1;
    } else if (a.status === "failed") {
      counts.failed += 1;
      counts.executed += 1;
    } else {
      counts.skipped += 1;
    }
  }
  return counts;
}

export function countTotals(results: VitestJsonResults): VitestAssertionCounts {
  const totals: VitestAssertionCounts = {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const tr of results.testResults ?? []) {
    const counts = countAssertions(tr.assertionResults);
    totals.executed += counts.executed;
    totals.passed += counts.passed;
    totals.failed += counts.failed;
    totals.skipped += counts.skipped;
  }
  return totals;
}
