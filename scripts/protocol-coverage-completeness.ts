/**
 * Suite-completeness guard for the sharded protocol-coverage sweep.
 *
 * The suites are hand-assigned to shards in e2e-tests-ephemeral.yml, so a
 * newly added `coverage.test.ts` that nobody wires into a shard would run
 * in none of them and silently vanish from coverage. This reads the merged
 * shard JSON results, compares the suites that actually loaded against every
 * `coverage.test.ts` on disk, and fails when any suite ran in zero shards.
 *
 * Runs in CI with only node builtins available (no dependencies).
 *
 * Usage: tsx scripts/protocol-coverage-completeness.ts <vitest.json...>
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VitestJsonResults } from "./vitest-assertion-counts";

const SUITE_ROOT = "tests/e2e/vitest/protocol-coverage";
const SUITE_FILE = "coverage.test.ts";
const MARKER = "protocol-coverage/";

// Reduce any absolute or relative path to its `<protocol>/<chain>/file` tail
// so on-disk discovery and vitest's absolute result paths compare equal.
function toSuiteKey(path: string): string {
  const idx = path.lastIndexOf(MARKER);
  const tail = idx === -1 ? path : path.slice(idx + MARKER.length);
  return tail.replace(/^[/\\]+/, "");
}

function discoverSuites(): string[] {
  const entries = readdirSync(SUITE_ROOT, {
    recursive: true,
    encoding: "utf8",
  });
  return entries
    .filter((e) => e.endsWith(SUITE_FILE))
    .map((e) => toSuiteKey(join(SUITE_ROOT, e)));
}

function ranSuites(files: string[]): Set<string> {
  const ran = new Set<string>();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as VitestJsonResults;
    for (const tr of raw.testResults ?? []) {
      if (tr.name) {
        ran.add(toSuiteKey(tr.name));
      }
    }
  }
  return ran;
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write(
      "usage: tsx scripts/protocol-coverage-completeness.ts <vitest.json...>\n"
    );
    process.exit(2);
  }
  const discovered = discoverSuites();
  const ran = ranSuites(files);
  const missing = discovered.filter((s) => !ran.has(s)).sort();

  process.stdout.write(
    `Suite completeness: ${discovered.length - missing.length}/${discovered.length} suites ran across ${files.length} shard result file(s)\n`
  );

  if (missing.length > 0) {
    process.stderr.write(
      `FAIL: ${missing.length} coverage suite(s) ran in no shard - add them to a ` +
        "shard's suite list in e2e-tests-ephemeral.yml:\n" +
        missing.map((s) => `  - ${s}`).join("\n") +
        "\n"
    );
    process.exit(1);
  }
}

main();
