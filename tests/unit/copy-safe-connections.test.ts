import { describe, expect, it } from "vitest";

import { SENDER_NOT_CHOSEN } from "@/lib/safe/sender-not-chosen";
import {
  listStepsNeedingSender,
  pinnedSafeIds,
  stepsNeedingSenderNotice,
  unsetUnownedSafes,
} from "@/lib/workflow/copy-safe-connections";
import { findActionById } from "@/plugins/registry";

function step(
  id: string,
  label: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  return { id, type: "action", data: { label, type: "action", config } };
}

function configOf(
  node: Record<string, unknown> | undefined
): Record<string, unknown> {
  const data = node?.data as { config?: Record<string, unknown> } | undefined;
  return data?.config ?? {};
}

const NODES = [
  { id: "t", type: "trigger", data: { label: "Manual", config: {} } },
  step("a", "Swap USDC", {
    actionType: "web3/write-contract",
    web3Connection: "safe:theirs",
  }),
  step("b", "Pay rent", {
    actionType: "web3/transfer-funds",
    web3Connection: "safe:mine",
  }),
  step("c", "Top up", {
    actionType: "web3/transfer-funds",
    web3Connection: "eoa",
  }),
  step("d", "", {
    actionType: "web3/transfer-funds",
    web3Connection: "safe:theirs",
  }),
  step("e", "No pin", { actionType: "web3/transfer-funds" }),
];

describe("pinnedSafeIds", () => {
  it("lists each Safe a step is pinned to once", () => {
    expect(pinnedSafeIds(NODES)).toEqual(["theirs", "mine"]);
  });

  it("asks no lookup for an empty Safe id or nodes without a config", () => {
    expect(
      pinnedSafeIds([step("x", "X", { web3Connection: "safe:" }), { id: "y" }])
    ).toEqual([]);
  });
});

describe("unsetUnownedSafes", () => {
  it("leaves steps on a Safe outside the owned set with no sender", () => {
    const { nodes, needingSender } = unsetUnownedSafes(
      NODES,
      new Set(["mine"])
    );
    const connection = (id: string): unknown =>
      configOf(nodes.find((node) => node.id === id)).web3Connection;

    expect(connection("a")).toBe(SENDER_NOT_CHOSEN);
    expect(connection("b")).toBe("safe:mine");
    // eoa is dropped, so the copier's own policy applies.
    expect(connection("c")).toBeUndefined();
    expect(connection("d")).toBe(SENDER_NOT_CHOSEN);
    expect(connection("e")).toBeUndefined();
    // A step with no label is named by its action's display name, never its id.
    const actionName = findActionById("web3/transfer-funds")?.label;
    expect(actionName).toBeTruthy();
    expect(needingSender).toEqual([
      { nodeId: "a", label: "Swap USDC" },
      { nodeId: "d", label: actionName },
    ]);
  });

  it("never falls back to the Default Sender or the EOA", () => {
    const { nodes } = unsetUnownedSafes(NODES, new Set());
    for (const id of ["a", "b", "d"]) {
      const value = configOf(
        nodes.find((node) => node.id === id)
      ).web3Connection;
      expect(value).toBe(SENDER_NOT_CHOSEN);
    }
  });

  it("keeps the rest of the config and leaves the input unchanged", () => {
    const { nodes } = unsetUnownedSafes(NODES, new Set());
    expect(configOf(nodes[1]).actionType).toBe("web3/write-contract");
    expect(configOf(NODES[1]).web3Connection).toBe("safe:theirs");
  });

  it("keeps every owned Safe", () => {
    const { nodes, needingSender } = unsetUnownedSafes(
      NODES,
      new Set(["mine", "theirs"])
    );
    expect(needingSender).toEqual([]);
    expect(nodes.filter((node) => node.id !== "c")).toEqual(
      NODES.filter((node) => node.id !== "c")
    );
  });

  it("drops eoa, default and a malformed Safe id, as the save fix's copy rule does", () => {
    const { nodes, needingSender } = unsetUnownedSafes(
      [
        step("x", "Broken", {
          actionType: "web3/transfer-funds",
          web3Connection: "safe:",
        }),
        step("y", "Default", {
          actionType: "web3/write-contract",
          web3Connection: "default",
        }),
        step("z", "EOA", {
          actionType: "robinhood/trade-stock-token",
          web3Connection: "eoa",
        }),
      ],
      new Set([""])
    );
    for (const node of nodes) {
      expect(configOf(node)).not.toHaveProperty("web3Connection");
    }
    expect(needingSender).toEqual([]);
  });

  it("drops a Safe on Batch Write Contract instead of marking it", () => {
    const { nodes, needingSender } = unsetUnownedSafes(
      [
        step("b", "Batch", {
          actionType: "web3/batch-write-contract",
          network: "1",
          web3Connection: "safe:theirs",
        }),
      ],
      new Set()
    );
    expect(configOf(nodes[0])).not.toHaveProperty("web3Connection");
    expect(needingSender).toEqual([]);
  });

  it("drops a Solana transfer's Safe, and marks the same step on an EVM network", () => {
    const transfer = (id: string, network: string) =>
      step(id, `Pay on ${network}`, {
        actionType: "web3/transfer-funds",
        network,
        web3Connection: "safe:theirs",
      });
    expect(pinnedSafeIds([transfer("sol", "101")])).toEqual([]);
    const { nodes, needingSender } = unsetUnownedSafes(
      [transfer("sol", "101"), transfer("evm", "1")],
      new Set()
    );
    expect(configOf(nodes[0])).not.toHaveProperty("web3Connection");
    expect(configOf(nodes[1]).web3Connection).toBe(SENDER_NOT_CHOSEN);
    expect(needingSender).toEqual([{ nodeId: "evm", label: "Pay on 1" }]);
  });

  it("drops the no-sender mark from a Solana transfer, which has no picker", () => {
    const { nodes, needingSender } = unsetUnownedSafes(
      [
        step("sol", "Pay in SOL", {
          actionType: "Transfer Funds",
          network: "101",
          web3Connection: SENDER_NOT_CHOSEN,
        }),
      ],
      new Set()
    );
    expect(configOf(nodes[0])).not.toHaveProperty("web3Connection");
    expect(needingSender).toEqual([]);
  });

  it("lists a step that already had no sender, unchanged", () => {
    const waiting = step("w", "Waiting", {
      actionType: "web3/approve-token",
      web3Connection: SENDER_NOT_CHOSEN,
    });
    const { nodes, needingSender } = unsetUnownedSafes([waiting], new Set());
    expect(nodes[0]).toBe(waiting);
    expect(needingSender).toEqual([{ nodeId: "w", label: "Waiting" }]);
  });

  it("drops the value on a step whose action never reads it, as on save", () => {
    const supply = step("s", "Supply", {
      actionType: "aave-v3/supply",
      web3Connection: "safe:theirs",
    });
    const sign = step("g", "Sign", {
      actionType: "web3/sign-typed-data",
      web3Connection: SENDER_NOT_CHOSEN,
    });
    expect(pinnedSafeIds([supply, sign])).toEqual([]);
    const { nodes, needingSender } = unsetUnownedSafes(
      [supply, sign],
      new Set()
    );
    for (const node of nodes) {
      expect(configOf(node)).not.toHaveProperty("web3Connection");
    }
    expect(configOf(nodes[0]).actionType).toBe("aave-v3/supply");
    expect(needingSender).toEqual([]);
  });

  it("marks a disabled step but leaves it out of the notice, like the checks", () => {
    const disabled = step("off", "Paused swap", {
      actionType: "web3/write-contract",
      web3Connection: "safe:theirs",
    });
    disabled.data = { ...(disabled.data as object), enabled: false };
    const { nodes, needingSender } = unsetUnownedSafes([disabled], new Set());
    expect(configOf(nodes[0]).web3Connection).toBe(SENDER_NOT_CHOSEN);
    expect(needingSender).toEqual([]);
  });
});

describe("listStepsNeedingSender", () => {
  it("names the enabled steps that already have no sender, with no lookup", () => {
    expect(
      listStepsNeedingSender([
        step("w", "Waiting", {
          actionType: "web3/transfer-token",
          web3Connection: SENDER_NOT_CHOSEN,
        }),
        step("p", "Picked", {
          actionType: "web3/transfer-token",
          web3Connection: "eoa",
        }),
      ])
    ).toEqual([{ nodeId: "w", label: "Waiting" }]);
  });
});

describe("stepsNeedingSenderNotice", () => {
  const stepNamed = (label: string, index = 0) => ({
    nodeId: `n${index}`,
    label,
  });

  it("is null when no step needs a sender", () => {
    expect(stepsNeedingSenderNotice([])).toBeNull();
  });

  it("leads with the outcome for one step", () => {
    expect(stepsNeedingSenderNotice([stepNamed("Swap USDC")])).toBe(
      '1 step used a Safe your organization does not own and needs a sender: "Swap USDC". Pick one under Web3 Connection in that step before running.'
    );
  });

  it("joins the last of several names with and", () => {
    expect(
      stepsNeedingSenderNotice([
        stepNamed("A", 1),
        stepNamed("B", 2),
        stepNamed("C", 3),
      ])
    ).toBe(
      '3 steps used a Safe your organization does not own and need a sender: "A", "B" and "C". Pick one under Web3 Connection in each step before running.'
    );
    expect(
      stepsNeedingSenderNotice([stepNamed("A", 1), stepNamed("B", 2)])
    ).toContain('"A" and "B".');
  });

  it("names at most three steps, then how many more", () => {
    const notice = stepsNeedingSenderNotice(
      ["A", "B", "C", "D", "E"].map((label, index) => stepNamed(label, index))
    );
    expect(notice).toContain("5 steps used");
    expect(notice).toContain('"A", "B", "C" and 2 more.');
    expect(notice).not.toContain('"D"');
  });

  it("cuts a long label to 40 characters", () => {
    const long = `Swap". Your wallet is at risk, visit example.test now`;
    const notice = stepsNeedingSenderNotice([stepNamed(long)]) ?? "";
    const quoted = notice.slice(
      notice.indexOf(': "') + 3,
      notice.lastIndexOf('"')
    );
    expect(quoted.length).toBeLessThanOrEqual(40);
    expect(quoted.endsWith("…")).toBe(true);
    expect(notice).not.toContain("example.test");
  });

  it("never names the template owner, so a same-org copy reads right", () => {
    expect(stepsNeedingSenderNotice([stepNamed("A")])).not.toContain(
      "template owner"
    );
  });
});
