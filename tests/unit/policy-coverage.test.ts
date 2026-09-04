import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/policy";
import { capabilityForAction, isReadAction } from "@/lib/policy/facts";
import { getAllActions } from "@/plugins/registry";

/**
 * The check that stops the policy engine quietly losing coverage.
 *
 * A write-capable action with no capability mapping is invisible to every
 * rule: policies about it silently do not apply, and nothing errors. This test
 * turns that from a silent gap into a failed build, which is the only way it
 * stays true as plugins are added.
 */

/**
 * Actions that move value, or let someone else move it.
 *
 * Reads are excluded through the same helper the classifier uses, so the test
 * and the code cannot disagree about what counts as a read.
 */
const WRITE_VERBS: readonly string[] = [
  "transfer",
  "approve",
  "write-contract",
  "swap",
  "supply",
  "withdraw",
  "borrow",
  "repay",
  "stake",
  "unstake",
  "deposit",
  "redeem",
  "sign-typed-data",
  "send-raw",
  "call-solana-program",
];

function isWriteCapable(action: { id: string; label: string }): boolean {
  if (isReadAction(action.id)) {
    return false;
  }
  const text = `${action.id} ${action.label}`.toLowerCase();
  return WRITE_VERBS.some((verb) => text.includes(verb));
}

describe("policy capability coverage", () => {
  it("maps every write-capable action to a capability", () => {
    const actions = getAllActions();
    const unmapped = actions
      .filter((a) => isWriteCapable(a))
      .filter((a) => capabilityForAction(a.id) === null)
      .map((a) => a.id);

    // A miss here means policies silently do not govern that action. Add it to
    // ACTION_CAPABILITY in lib/policy/facts.ts, or to the protocol verb
    // patterns if it is a protocol action.
    expect(unmapped).toEqual([]);
  });

  it("only maps to capabilities that exist in the registry", () => {
    const actions = getAllActions();
    for (const action of actions) {
      const capability = capabilityForAction(action.id);
      if (capability) {
        expect(CAPABILITIES[capability]).toBeDefined();
      }
    }
  });

  it("marks every capability a write action maps to as value-moving", () => {
    const actions = getAllActions();
    for (const action of actions) {
      if (!isWriteCapable(action)) {
        continue;
      }
      const capability = capabilityForAction(action.id);
      if (!capability) {
        continue;
      }
      // A write action mapped onto a read capability would pass a policy meant
      // to bound spending.
      expect(CAPABILITIES[capability].valueMoving).toBe(true);
    }
  });
});
