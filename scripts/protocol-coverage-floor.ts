/**
 * Executed-test floor for the protocol-coverage CI step.
 *
 * Every protocol suite self-skips when its infra gates (fork URLs,
 * funder key, database) are absent, so a green exit code can mean
 * "ran nothing" - which is how coverage silently collapsed to ~35
 * executed tests without anyone noticing. This script reads the vitest
 * JSON results, fails when the executed count drops below the floor,
 * and publishes run/skip counts to the GitHub step summary.
 *
 * Usage: tsx scripts/protocol-coverage-floor.ts <vitest.json> <floor>
 */

import { appendFileSync, readFileSync } from "node:fs";
import {
  countTotals,
  type VitestJsonResults,
} from "./vitest-assertion-counts";

function main(): void {
  // All args except the last are vitest JSON files; the last is the floor.
  // One file keeps the single-suite behaviour; several are merged so a
  // sharded run checks the floor against the whole sweep, not one shard.
  const args = process.argv.slice(2);
  const floorArg = args.pop();
  const files = args;
  if (!(files.length && floorArg)) {
    process.stderr.write(
      "usage: tsx scripts/protocol-coverage-floor.ts <vitest.json...> <floor>\n"
    );
    process.exit(2);
  }
  const floor = Number(floorArg);
  if (!(Number.isFinite(floor) && floor >= 0)) {
    // NaN would make `executed < floor` always false, silently disabling
    // the guard - the exact failure mode this script exists to prevent.
    process.stderr.write(
      `invalid floor argument "${floorArg}": expected a non-negative number\n`
    );
    process.exit(2);
  }
  const testResults: NonNullable<VitestJsonResults["testResults"]> = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as VitestJsonResults;
    testResults.push(...(raw.testResults ?? []));
  }
  const { executed, passed, failed, skipped } = countTotals({ testResults });

  const summary = `Protocol coverage: executed ${executed} (passed ${passed}, failed ${failed}), skipped ${skipped}, floor ${floor}`;
  process.stdout.write(`${summary}\n`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(
      summaryFile,
      `### Protocol coverage\n\n| Executed | Passed | Failed | Skipped | Floor |\n|---|---|---|---|---|\n| ${executed} | ${passed} | ${failed} | ${skipped} | ${floor} |\n`
    );
  }

  if (executed < floor) {
    process.stderr.write(
      `FAIL: executed ${executed} tests, below the floor of ${floor}. ` +
        "The suites are self-skipping - check the infra gates " +
        "(ANVIL_FORK_MAINNET_URL, TESTNET_FUNDER_PK, DATABASE_URL) " +
        "before trusting this green.\n"
    );
    process.exit(1);
  }
}

main();
