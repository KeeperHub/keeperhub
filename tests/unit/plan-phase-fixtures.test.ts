/**
 * Unit tests for planPhaseFixtures.
 *
 * planPhaseFixtures is the pure decision layer behind runPhaseFixtures.
 * Tested in isolation so a regression in the `chainData.skipped` honouring
 * (or any of the early-return branches) fails in `pnpm test:unit` instead
 * of slipping into a green CI run where vitest's reporter just shows fewer
 * test names than expected.
 */

import { describe, expect, it } from "vitest";
import type {
  ProtocolAction,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import { planPhaseFixtures } from "@/lib/test-data/plan";

function makeAction(
  slug: string,
  type: "read" | "write" = "write"
): ProtocolAction {
  return {
    slug,
    label: slug,
    description: "",
    type,
    contract: "main",
    function: slug,
    inputs: [],
  };
}

function makeProtocol(
  slug: string,
  actions: ProtocolAction[],
  skipped?: Record<string, string>
): ProtocolDefinition {
  return {
    name: slug,
    slug,
    description: "",
    contracts: {},
    actions,
    testData: skipped
      ? {
          "11155111": {
            setup: { minNativeHuman: "0", requiredTokens: [], approvals: [] },
            actions: {},
            skipped,
          },
        }
      : undefined,
  };
}

describe("planPhaseFixtures", () => {
  it("emits a no-protocol case when the protocol is undefined", () => {
    const plan = planPhaseFixtures(undefined, "ghost", "11155111", "write");
    expect(plan).toEqual([{ kind: "no-protocol", protocolSlug: "ghost" }]);
  });

  it("emits a no-actions case when no action matches the phase", () => {
    const protocol = makeProtocol("p", [makeAction("a", "read")]);
    const plan = planPhaseFixtures(protocol, "p", "11155111", "write");
    expect(plan).toEqual([
      { kind: "no-actions", protocolSlug: "p", phase: "write" },
    ]);
  });

  it("filters out actions of the other phase", () => {
    const writeAction = makeAction("supply", "write");
    const readAction = makeAction("get-data", "read");
    const protocol = makeProtocol("p", [writeAction, readAction]);
    const plan = planPhaseFixtures(protocol, "p", "11155111", "write");
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: "run", action: writeAction });
  });

  it("marks `run` for actions not listed in `skipped`", () => {
    const supply = makeAction("supply");
    const protocol = makeProtocol("p", [supply], { distribute: "needs pool" });
    const plan = planPhaseFixtures(protocol, "p", "11155111", "write");
    expect(plan).toEqual([{ kind: "run", action: supply }]);
  });

  it("marks `skip` for actions listed in `skipped`, preserving reason", () => {
    const distribute = makeAction("distribute");
    const protocol = makeProtocol("p", [distribute], {
      distribute: "needs real pool",
    });
    const plan = planPhaseFixtures(protocol, "p", "11155111", "write");
    expect(plan).toEqual([
      { kind: "skip", action: distribute, reason: "needs real pool" },
    ]);
  });

  it("mixes `run` and `skip` per the skipped map", () => {
    const supply = makeAction("supply");
    const distribute = makeAction("distribute");
    const connect = makeAction("connect");
    const protocol = makeProtocol("p", [supply, distribute, connect], {
      distribute: "pool dep",
      connect: "pool dep",
    });
    const plan = planPhaseFixtures(protocol, "p", "11155111", "write");
    expect(plan).toEqual([
      { kind: "run", action: supply },
      { kind: "skip", action: distribute, reason: "pool dep" },
      { kind: "skip", action: connect, reason: "pool dep" },
    ]);
  });

  it("falls back to all-run when skipped is omitted on the chain entry", () => {
    const supply = makeAction("supply");
    // No testData at all -- chainData.skipped lookup falls to {}.
    const protocol = makeProtocol("p", [supply]);
    const plan = planPhaseFixtures(protocol, "p", "11155111", "write");
    expect(plan).toEqual([{ kind: "run", action: supply }]);
  });

  it("scopes skipped to the requested chain id", () => {
    // Mainnet has `supply` in its skip map; Sepolia does not. Plan for
    // Sepolia should still emit `run` for supply.
    const supply = makeAction("supply");
    const protocol: ProtocolDefinition = {
      name: "p",
      slug: "p",
      description: "",
      contracts: {},
      actions: [supply],
      testData: {
        "1": {
          setup: { minNativeHuman: "0", requiredTokens: [], approvals: [] },
          actions: {},
          skipped: { supply: "mainnet-only skip" },
        },
        "11155111": {
          setup: { minNativeHuman: "0", requiredTokens: [], approvals: [] },
          actions: {},
        },
      },
    };
    const plan = planPhaseFixtures(protocol, "p", "11155111", "write");
    expect(plan).toEqual([{ kind: "run", action: supply }]);
  });
});

describe("planPhaseFixtures representatives mode", () => {
  const proto = makeProtocol(
    "p",
    [makeAction("w1"), makeAction("w2"), makeAction("w3")],
    { w1: "documented skip" }
  );

  it("keeps only the first runnable action, preserving documented skips", () => {
    const plan = planPhaseFixtures(proto, "p", "11155111", "write", {
      representatives: true,
    });
    expect(plan.map((c) => c.kind)).toEqual(["skip", "run", "skip"]);
    const last = plan[2];
    expect(last.kind === "skip" && last.reason).toContain("representatives");
  });

  it("is a no-op when disabled", () => {
    const plan = planPhaseFixtures(proto, "p", "11155111", "write");
    expect(plan.map((c) => c.kind)).toEqual(["skip", "run", "run"]);
  });
});
