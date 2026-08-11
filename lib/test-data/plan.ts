/**
 * Pure fixture-planning layer for protocol-coverage.
 *
 * Lives apart from the coverage runner
 * (tests/e2e/vitest/protocol-coverage/_shared/run-fixture.ts) because
 * that module imports vitest,
 * which throws when loaded outside a test run - and this logic is also
 * consumed by scripts/protocol-coverage-report.ts (a tsx CLI). The
 * coverage report must agree exactly with what the runner registers, so
 * both import this single implementation. Placed under lib/test-data
 * (its only import is type-only) so non-test consumers do not have to
 * reach into tests/.
 */

import type {
  ProtocolAction,
  ProtocolDefinition,
} from "@/lib/protocol-registry";

/**
 * Planned per-action outcome for a phase: either a real test that should
 * register, or a documented skip.
 *
 *   - `run` carries the action so the caller can build a workflow for it.
 *   - `skip` carries the reason (used in the test name and shown by the
 *     vitest reporter so a green run still surfaces what was skipped).
 *   - `no-protocol` / `no-actions` cover the early-return branches in
 *     `runPhaseFixtures` (unknown protocol slug, no actions for phase).
 */
export type FixtureCase =
  | { kind: "run"; action: ProtocolAction }
  | { kind: "skip"; action: ProtocolAction; reason: string }
  | { kind: "no-protocol"; protocolSlug: string }
  | { kind: "no-actions"; protocolSlug: string; phase: "read" | "write" };

export function planPhaseFixtures(
  protocol: ProtocolDefinition | undefined,
  protocolSlug: string,
  chainId: string,
  phase: "read" | "write",
  opts?: {
    /**
     * Representatives mode: keep only the first runnable action per
     * phase and mark the rest as documented skips. The full per-action
     * breadth is Tier 0/1's job; the end-to-end path this suite proves
     * (webhook, executor, signing, receipt) is shared by every action,
     * so one representative read and write per chain suffices for the
     * PR gate while the full sweep runs nightly.
     */
    representatives?: boolean;
  }
): FixtureCase[] {
  if (!protocol) {
    return [{ kind: "no-protocol", protocolSlug }];
  }
  const actions = protocol.actions.filter((a) => a.type === phase);
  if (actions.length === 0) {
    return [{ kind: "no-actions", protocolSlug, phase }];
  }
  const skipped = protocol.testData?.[chainId]?.skipped ?? {};
  const plan: FixtureCase[] = actions.map((action) => {
    const reason = skipped[action.slug];
    if (reason) {
      return { kind: "skip", action, reason };
    }
    return { kind: "run", action };
  });
  if (!opts?.representatives) {
    return plan;
  }
  let kept = false;
  return plan.map((c) => {
    if (c.kind !== "run") {
      return c;
    }
    if (kept) {
      return {
        kind: "skip",
        action: c.action,
        reason:
          "representatives mode: covered by Tier 0/1; first runnable action represents this phase",
      };
    }
    kept = true;
    return c;
  });
}
