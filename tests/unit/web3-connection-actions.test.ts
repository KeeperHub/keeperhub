import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SENDER_NOT_CHOSEN } from "@/lib/safe/sender-not-chosen";
import { PLUGIN_STEP_IMPORTERS } from "@/lib/step-registry";
import {
  actionTakesSafeSender,
  actionTakesWeb3Connection,
  fixedSenderNote,
  isUnsetWeb3Connection,
  isValidWeb3Connection,
  stepNeedsSender,
  stepTakesWeb3Connection,
  web3ConnectionProblem,
  withOnlySafeWeb3Connections,
  withoutIgnoredWeb3Connection,
  withoutIgnoredWeb3Connections,
} from "@/lib/workflow/web3-connection";
import { getAllActions } from "@/plugins/registry";

const ROOT = join(import.meta.dirname, "..", "..");

// Each step core that resolves its signer from the node's Web3 Connection,
// and the action it runs.
const CORE_ACTIONS: Record<string, string> = {
  "plugins/web3/steps/write-contract-core.ts": "web3/write-contract",
  "plugins/web3/steps/batch-write-contract-core.ts":
    "web3/batch-write-contract",
  "plugins/web3/steps/approve-token-core.ts": "web3/approve-token",
  "plugins/web3/steps/transfer-funds-core.ts": "web3/transfer-funds",
  "plugins/web3/steps/transfer-token-core.ts": "web3/transfer-token",
  "plugins/robinhood/steps/trade-stock-token-core.ts":
    "robinhood/trade-stock-token",
};

function stepFiles(): string[] {
  const files: string[] = [];
  for (const plugin of readdirSync(join(ROOT, "plugins"), {
    withFileTypes: true,
  })) {
    if (!plugin.isDirectory()) {
      continue;
    }
    const steps = join("plugins", plugin.name, "steps");
    let names: string[];
    try {
      names = readdirSync(join(ROOT, steps));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".ts")) {
        files.push(`${steps}/${name}`);
      }
    }
  }
  return files;
}

describe("actions that take a Web3 Connection", () => {
  it("are exactly the steps that resolve their signer from it", () => {
    const resolving = stepFiles().filter((file) =>
      readFileSync(join(ROOT, file), "utf8").includes("resolveSignerForNode(")
    );
    expect(resolving.sort()).toEqual(Object.keys(CORE_ACTIONS).sort());

    const taking = getAllActions()
      .map((action) => action.id)
      .filter((id) => actionTakesWeb3Connection(id));
    expect(taking.sort()).toEqual(Object.values(CORE_ACTIONS).sort());
  });

  it("are exactly the step files that mention it", () => {
    const mentioning = stepFiles().filter((file) =>
      readFileSync(join(ROOT, file), "utf8").includes("web3Connection")
    );
    expect(mentioning.sort()).toEqual(Object.keys(CORE_ACTIONS).sort());
  });

  it("include every registry id that runs one of those steps, legacy ids too", () => {
    const honouringSteps = new Set(
      Object.values(CORE_ACTIONS).map(
        (id) => PLUGIN_STEP_IMPORTERS[id].stepFunction
      )
    );
    const runsHonouringStep = Object.entries(PLUGIN_STEP_IMPORTERS)
      .filter(([, importer]) => honouringSteps.has(importer.stepFunction))
      .map(([id]) => id);
    expect(runsHonouringStep).toEqual(
      expect.arrayContaining(["Write Contract", "Transfer Funds"])
    );
    for (const [id, importer] of Object.entries(PLUGIN_STEP_IMPORTERS)) {
      expect([id, actionTakesWeb3Connection(id)]).toEqual([
        id,
        honouringSteps.has(importer.stepFunction),
      ]);
    }
  });

  it("leave protocol writes out, which never pass it to the write", () => {
    const source = readFileSync(
      join(ROOT, "plugins/protocol/steps/protocol-write.ts"),
      "utf8"
    );
    expect(source).toContain("writeContractCore(");
    expect(source).not.toContain("web3Connection");
    expect(actionTakesWeb3Connection("aave-v3/supply")).toBe(false);
    expect(actionTakesWeb3Connection(undefined)).toBe(false);
  });
});

describe("isValidWeb3Connection", () => {
  it.each([
    "",
    "default",
    "eoa",
    "safe:abc",
    "safe:0a1b2c3d4e5f6g7h8i9j0",
    "safe:safe-1",
    SENDER_NOT_CHOSEN,
  ])("accepts %j", (value) => {
    expect(isValidWeb3Connection(value)).toBe(true);
  });

  it.each([
    "safe:",
    "safe: ",
    "safe: abc",
    "safe:abc ",
    "safe:{{@n1:Trigger.safeId}}",
    "safe:a{{x}}",
    "{{@n1:Trigger.sender}}",
    "EOA",
    "x",
    1,
    null,
    undefined,
  ])("refuses %j", (value) => {
    expect(isValidWeb3Connection(value)).toBe(false);
  });
});

describe("web3ConnectionProblem", () => {
  it("refuses a Safe only on Batch Write Contract", () => {
    expect(actionTakesSafeSender("web3/batch-write-contract")).toBe(false);
    expect(actionTakesSafeSender("Write Contract")).toBe(true);
    expect(
      web3ConnectionProblem("web3/batch-write-contract", "safe:s1")?.message
    ).toContain("sends every call from your EOA");
    expect(web3ConnectionProblem("web3/batch-write-contract", "eoa")).toBe(
      null
    );
    expect(web3ConnectionProblem("web3/write-contract", "safe:s1")).toBe(null);
    expect(web3ConnectionProblem("web3/write-contract", undefined)).toBe(null);
  });
});

describe("fixedSenderNote", () => {
  it("names who sends on a step that ignores the picked sender", () => {
    expect(fixedSenderNote("aave-v3/supply", "1")).toBe(
      "Sent from your Default Sender (organization policy)"
    );
    expect(fixedSenderNote("web3/sign-typed-data", "1")).toBe(
      "Signed by your organization's EOA"
    );
    expect(fixedSenderNote("web3/transfer-spl-token", "101")).toBe(
      "Sent from your organization's Solana wallet"
    );
    expect(fixedSenderNote("web3/transfer-funds", "101")).toBe(
      "Sent from your organization's Solana wallet"
    );
  });

  it("is null where the picker applies", () => {
    expect(fixedSenderNote("web3/transfer-funds", "1")).toBe(null);
    expect(fixedSenderNote("web3/transfer-funds", "{{@t:T.chain}}")).toBe(null);
    expect(fixedSenderNote("Transfer Funds", undefined)).toBe(null);
    expect(fixedSenderNote("robinhood/trade-stock-token", "4663")).toBe(null);
  });
});

describe("stepTakesWeb3Connection", () => {
  it("matches where the picker applies", () => {
    expect(stepTakesWeb3Connection("web3/write-contract", "1")).toBe(true);
    expect(stepTakesWeb3Connection("web3/transfer-funds", "1")).toBe(true);
    expect(stepTakesWeb3Connection("Transfer Funds", "{{@t:T.chain}}")).toBe(
      true
    );
    expect(stepTakesWeb3Connection("web3/transfer-funds", "101")).toBe(false);
    expect(stepTakesWeb3Connection("Transfer Funds", "101")).toBe(false);
    expect(stepTakesWeb3Connection("aave-v3/supply", "1")).toBe(false);
  });

  it("is the editor's picker rule", () => {
    for (const actionType of [
      "web3/write-contract",
      "web3/batch-write-contract",
      "web3/transfer-funds",
      "Transfer Funds",
      "web3/transfer-spl-token",
      "web3/sign-typed-data",
      "aave-v3/supply",
    ]) {
      for (const network of ["1", "101", "{{@t:T.chain}}", undefined]) {
        expect([
          actionType,
          network,
          stepTakesWeb3Connection(actionType, network),
        ]).toEqual([
          actionType,
          network,
          fixedSenderNote(actionType, network) === null,
        ]);
      }
    }
  });

  it("drops a key on a Solana transfer, keeps it on an EVM one", () => {
    const transfer = (network: string) => ({
      actionType: "web3/transfer-funds",
      network,
      web3Connection: "safe:x",
    });
    expect(withoutIgnoredWeb3Connection(transfer("101"))).toEqual({
      actionType: "web3/transfer-funds",
      network: "101",
    });
    expect(withoutIgnoredWeb3Connection(transfer("1"))).toEqual(transfer("1"));
  });
});

describe("withoutIgnoredWeb3Connection", () => {
  it("keeps it on an action that reads it", () => {
    const config = {
      actionType: "web3/write-contract",
      web3Connection: "safe:s1",
    };
    expect(withoutIgnoredWeb3Connection(config)).toBe(config);
  });

  it("drops a null one", () => {
    expect(
      withoutIgnoredWeb3Connection({
        actionType: "web3/write-contract",
        web3Connection: null,
      })
    ).toEqual({ actionType: "web3/write-contract" });
  });

  it("drops it everywhere else", () => {
    expect(
      withoutIgnoredWeb3Connection({
        actionType: "lido/wrap",
        web3Connection: "safe:s1",
        amount: "1",
      })
    ).toEqual({ actionType: "lido/wrap", amount: "1" });
  });
});

describe("withOnlySafeWeb3Connections", () => {
  it("keeps a Safe, drops eoa and default, and leaves the rest", () => {
    const nodes = [
      {
        id: "a",
        data: {
          label: "A",
          config: { actionType: "web3/write-contract", web3Connection: "eoa" },
        },
      },
      {
        id: "s",
        data: {
          config: {
            actionType: "web3/write-contract",
            web3Connection: "safe:s1",
          },
        },
      },
      {
        id: "d",
        data: {
          config: {
            actionType: "web3/transfer-token",
            web3Connection: "default",
          },
        },
      },
      { id: "b", data: { config: { actionType: "web3/read-contract" } } },
      { id: "c" },
    ];
    expect(withOnlySafeWeb3Connections(nodes)).toEqual([
      {
        id: "a",
        data: { label: "A", config: { actionType: "web3/write-contract" } },
      },
      nodes[1],
      { id: "d", data: { config: { actionType: "web3/transfer-token" } } },
      nodes[3],
      nodes[4],
    ]);
  });
});

describe("stepNeedsSender", () => {
  it("is true only on an action that reads the mark", () => {
    expect(
      stepNeedsSender({
        actionType: "web3/transfer-funds",
        web3Connection: SENDER_NOT_CHOSEN,
      })
    ).toBe(true);
    for (const actionType of [
      "aave-v3/supply",
      "web3/sign-typed-data",
      "discord/send-message",
      undefined,
    ]) {
      expect(
        stepNeedsSender({ actionType, web3Connection: SENDER_NOT_CHOSEN })
      ).toBe(false);
    }
  });

  it("is false on Transfer Native Token on a Solana network", () => {
    const mark = { web3Connection: SENDER_NOT_CHOSEN };
    expect(
      stepNeedsSender({
        ...mark,
        actionType: "web3/transfer-funds",
        network: "101",
      })
    ).toBe(false);
    expect(
      stepNeedsSender({ ...mark, actionType: "Transfer Funds", network: "101" })
    ).toBe(false);
    expect(
      stepNeedsSender({
        ...mark,
        actionType: "web3/transfer-funds",
        network: "1",
      })
    ).toBe(true);
  });

  it("is false once a sender is picked, or with no config", () => {
    expect(
      stepNeedsSender({
        actionType: "web3/write-contract",
        web3Connection: "eoa",
      })
    ).toBe(false);
    expect(stepNeedsSender(undefined)).toBe(false);
  });
});

describe("withOnlySafeWeb3Connections on a step that takes no Safe", () => {
  it("drops a Safe on Batch, a malformed Safe and one an action ignores", () => {
    const node = (actionType: string, web3Connection: string) => ({
      id: actionType,
      data: { config: { actionType, web3Connection } },
    });
    expect(
      withOnlySafeWeb3Connections([
        node("web3/batch-write-contract", "safe:s1"),
        node("web3/write-contract", "safe:"),
        node("web3/write-contract", "safe:{{@t:T.safe}}"),
        node("aave-v3/supply", "safe:s1"),
        node("Write Contract", "safe:s1"),
      ]).map((n) => n.data.config)
    ).toEqual([
      { actionType: "web3/batch-write-contract" },
      { actionType: "web3/write-contract" },
      { actionType: "web3/write-contract" },
      { actionType: "aave-v3/supply" },
      { actionType: "Write Contract", web3Connection: "safe:s1" },
    ]);
  });

  it("keeps the no-sender mark only where a Safe is taken", () => {
    const node = (actionType: string) => ({
      id: actionType,
      data: { config: { actionType, web3Connection: SENDER_NOT_CHOSEN } },
    });
    expect(
      withOnlySafeWeb3Connections([
        node("web3/transfer-token"),
        node("web3/batch-write-contract"),
        node("aave-v3/supply"),
      ]).map((n) => n.data.config)
    ).toEqual([
      { actionType: "web3/transfer-token", web3Connection: SENDER_NOT_CHOSEN },
      { actionType: "web3/batch-write-contract" },
      { actionType: "aave-v3/supply" },
    ]);
  });
});

describe("withoutIgnoredWeb3Connections", () => {
  it("drops a stale key from action nodes only", () => {
    const aave = {
      id: "a",
      type: "action",
      data: {
        config: { actionType: "aave-v3/supply", web3Connection: "eoa" },
      },
    };
    const write = {
      id: "w",
      type: "action",
      data: {
        config: { actionType: "web3/write-contract", web3Connection: "eoa" },
      },
    };
    const trigger = { id: "t", type: "trigger", data: { config: {} } };
    const out = withoutIgnoredWeb3Connections([aave, write, trigger]);
    expect(out[0]).toEqual({
      id: "a",
      type: "action",
      data: { config: { actionType: "aave-v3/supply" } },
    });
    expect(out[1]).toBe(write);
    expect(out[2]).toBe(trigger);
    // The editor's in-memory node is not mutated.
    expect(aave.data.config.web3Connection).toBe("eoa");
  });
});

describe("isUnsetWeb3Connection", () => {
  it("is true for empty, default and null only", () => {
    expect(isUnsetWeb3Connection("")).toBe(true);
    expect(isUnsetWeb3Connection("default")).toBe(true);
    expect(isUnsetWeb3Connection(null)).toBe(true);
    expect(isUnsetWeb3Connection("eoa")).toBe(false);
    expect(isUnsetWeb3Connection("safe:s1")).toBe(false);
    expect(isUnsetWeb3Connection(undefined)).toBe(false);
  });
});
