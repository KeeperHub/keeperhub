// TEST-01: 21-workflow validate_workflow smoke fixture.
//
// Asserts the validator produces ZERO false-positive errors against every
// workflow in the KH catalog fixture. Warnings are allowed and expected
// (proxy contracts, write-action-on-read-workflow heuristics, AI node
// bare-@ content that is correctly skipped by the validator).
//
// Fast tier only — deep tier (deepCheck=true) is unit-tested separately
// (Plan 48-03) with mocked resolveAbi. Running deep tier against real
// contracts in CI would hit etherscan rate limits and is not the
// regression surface for this gate.
//
// To refresh: re-run scripts/record-listed-workflows-fixture.ts against
// staging or prod DB with a new YYYY-MM-DD in OUT_FILE, then update
// FIXTURE_PATH + EXPECTED_WORKFLOW_COUNT below.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  "../fixtures/listed-workflows-2026-05-16.json"
);

// Update this when the fixture is intentionally re-recorded. Drift from
// the fixture's actual workflowCount surfaces a failure so silent
// catalog growth never goes unnoticed by the gate.
const EXPECTED_WORKFLOW_COUNT = 21;

// MUST be empty before merge. If you find a workflow that legitimately
// fails the validator due to a pre-existing data issue (NOT a validator
// bug), document it here AND open a Linear ticket to fix the listing.
// Permanent exclusions are NOT accepted — the array must be empty to
// satisfy TEST-01.
const KNOWN_LEGACY_BROKEN_WORKFLOWS: string[] = [];

// Hardcoded chainIds — common KH-supported chains. Avoids depending on
// the chains table being seeded in CI. Refresh if a new chain is added
// to the chains table that is referenced by any listed workflow.
const CHAIN_IDS = new Set([
  1, // Ethereum
  8453, // Base
  10, // Optimism
  42_161, // Arbitrum
  137, // Polygon
  100, // Gnosis
  11_155_111, // Sepolia
  4217, // Tempo
]);

type FixtureFile = {
  recordedAt: string;
  recordedFromEnv: string;
  workflowCount: number;
  workflows: Array<ValidatorWorkflow & { slug: string }>;
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureFile;

describe("validate_workflow smoke (TEST-01)", () => {
  it("fixture workflowCount matches EXPECTED_WORKFLOW_COUNT", () => {
    expect(
      fixture.workflowCount,
      `fixture has ${fixture.workflowCount} workflows but test expects ${EXPECTED_WORKFLOW_COUNT}. ` +
        "Either update EXPECTED_WORKFLOW_COUNT to reflect the new catalog size, or revert the fixture."
    ).toBe(EXPECTED_WORKFLOW_COUNT);
  });

  for (const wf of fixture.workflows) {
    if (KNOWN_LEGACY_BROKEN_WORKFLOWS.includes(wf.slug)) {
      it.skip(`zero errors for ${wf.slug} (skipped — legacy broken, see Linear ticket)`, () => {
        // tracked in Linear — must be resolved before merge
      });
      continue;
    }

    it(`validateWorkflow has zero errors for ${wf.slug}`, () => {
      const result = validateWorkflow(wf, { chainIds: CHAIN_IDS });

      // Surface the full result in the failure message so CI logs are
      // immediately diagnosable without re-running locally.
      expect(
        result.errors,
        `validate_workflow produced errors for listed workflow "${wf.slug}":\n${JSON.stringify(result, null, 2)}`
      ).toHaveLength(0);

      if (result.warnings.length > 0) {
        // Warnings are allowed — log for visibility so reviewers can see
        // which proxy contracts or read/write mismatches exist in catalog.
        console.warn(
          `${wf.slug}: ${result.warnings.length} warning(s) (allowed): ${result.warnings.map((w) => w.code).join(", ")}`
        );
      }
    });
  }
});
