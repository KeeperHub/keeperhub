import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rows = vi.hoisted(() => ({
  value: [] as {
    chainId: number;
    usePrivateMempoolRpc: boolean | null;
    defaultPrivateRpcUrl?: string | null;
  }[],
  queries: 0,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          rows.queries += 1;
          return Promise.resolve(rows.value);
        },
      }),
    }),
  },
}));

import { validateWorkflowNodesForSave } from "@/lib/workflow/validation/save";
import {
  reconcileSendModeKeys,
  validateSendModeForSave,
} from "@/lib/workflow/validation/send-mode";

function write(
  id: string,
  config: Record<string, unknown>,
  actionType = "web3/write-contract"
) {
  return {
    id,
    type: "action",
    data: { type: "action", label: id, config: { actionType, ...config } },
  };
}

beforeEach(() => {
  rows.value = [
    {
      chainId: 1,
      usePrivateMempoolRpc: true,
      defaultPrivateRpcUrl: "https://relay.example",
    },
    { chainId: 8453, usePrivateMempoolRpc: false },
  ];
  rows.queries = 0;
});

// The old two-argument shape: nodes, then the saved nodes.
function validateChains(
  nodes: Parameters<typeof validateSendModeForSave>[0],
  savedNodes?: Parameters<typeof validateSendModeForSave>[0]
) {
  return validateSendModeForSave(nodes, { savedNodes });
}

describe("validateSendModeForSave", () => {
  it("does not query for Normal sends", async () => {
    const result = await validateChains([
      write("a", { network: "8453" }),
      write("b", { network: "1", sendMode: "transaction" }),
    ]);
    expect(result.valid).toBe(true);
    expect(rows.queries).toBe(0);
  });

  it("accepts the private relay on a chain that has one", async () => {
    const result = await validateChains([
      write("a", { network: "1", sendMode: "private-relay" }),
      write(
        "b",
        { network: "1", usePrivateMempool: true },
        "web3/transfer-funds"
      ),
    ]);
    expect(result.valid).toBe(true);
  });

  it("refuses the private relay on a chain without one or unknown, legacy flag included", async () => {
    const result = await validateChains([
      write("a", { network: "8453", sendMode: "private-relay" }),
      write("b", { network: "8453", usePrivateMempool: true }),
      write("c", { network: "999999", sendMode: "private-relay" }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "nodes[0].data.config.sendMode",
      "nodes[1].data.config.sendMode",
      "nodes[2].data.config.sendMode",
    ]);
    expect(result.issues[0].message).toBe(
      'Send as "private-relay" is not available on chain 8453. Set sendMode to "transaction", or use a network that offers it.'
    );
  });

  it("counts a chain as having a relay only with a relay URL set, as the run does", async () => {
    rows.value = [{ chainId: 1, usePrivateMempoolRpc: true }];
    const result = await validateChains([
      write("a", { network: "1", sendMode: "private-relay" }),
    ]);
    expect(result.issues[0]?.message).toContain("not available on chain 1");
  });

  it("lets an unchanged saved node through", async () => {
    const saved = [write("a", { network: "8453", usePrivateMempool: true })];
    expect(
      (
        await validateChains(
          [write("a", { network: "8453", usePrivateMempool: true })],
          saved
        )
      ).valid
    ).toBe(true);
    // Moving it to another chain without a relay is a new choice.
    rows.value.push({ chainId: 10, usePrivateMempoolRpc: false });
    expect(
      (
        await validateChains(
          [write("a", { network: "10", sendMode: "private-relay" })],
          saved
        )
      ).valid
    ).toBe(false);
  });

  it("skips templates and actions without Send as", async () => {
    const result = await validateChains([
      write("a", { network: "{{@x:X.chain}}", sendMode: "private-relay" }),
      write(
        "b",
        { network: "8453", usePrivateMempool: true },
        "web3/read-contract"
      ),
    ]);
    expect(result.valid).toBe(true);
    expect(rows.queries).toBe(0);
  });

  it("refuses the private relay on Batch Write Contract, legacy flag and templates included", async () => {
    const batch = "web3/batch-write-contract";
    const result = await validateChains([
      write("a", { network: "1", sendMode: "private-relay" }, batch),
      write("b", { network: "1", usePrivateMempool: true }, batch),
      write("c", { network: "{{@x:X.chain}}", usePrivateMempool: true }, batch),
      write("d", { network: "1", sendMode: "transaction" }, batch),
    ]);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "nodes[0].data.config.sendMode",
      "nodes[1].data.config.sendMode",
      "nodes[2].data.config.sendMode",
    ]);
    expect(result.issues[0].message).toBe(
      'Send as "private-relay" is not available on this step. Batch Write Contract can\'t send through the private relay yet, so this step fails before sending. Set Send as to Normal transaction (sendMode: "transaction"), or split the calls into Write Contract steps to keep them private.'
    );
  });

  it("keeps a Batch Write Contract step saved unchanged with the private relay", async () => {
    const batch = "web3/batch-write-contract";
    const saved = [
      write("a", { network: "1", usePrivateMempool: true }, batch),
    ];
    const result = await validateChains(
      [
        write(
          "a",
          { network: "1", usePrivateMempool: true, calls: "[]" },
          batch
        ),
      ],
      saved
    );
    expect(result.valid).toBe(true);
  });

  it("keeps a saved Batch relay step saveable when only its network changes", async () => {
    const batch = "web3/batch-write-contract";
    rows.value = [
      ...rows.value,
      {
        chainId: 10,
        usePrivateMempoolRpc: true,
        defaultPrivateRpcUrl: "https://relay.example",
      },
    ];
    const result = await validateChains(
      [write("a", { network: "10", usePrivateMempool: true }, batch)],
      [write("a", { network: "1", usePrivateMempool: true }, batch)]
    );
    expect(result.valid).toBe(true);
  });

  it("refuses a Write Contract saved with the relay and switched to Batch", async () => {
    const saved = [write("a", { network: "1", sendMode: "private-relay" })];
    const result = await validateChains(
      [
        write(
          "a",
          { network: "1", sendMode: "private-relay" },
          "web3/batch-write-contract"
        ),
      ],
      saved
    );
    expect(result.issues[0]?.message).toContain(
      "Batch Write Contract can't send through the private relay yet"
    );
  });

  it("asks new legacy flag values to be booleans and keeps stored ones", async () => {
    const refused = await validateChains([
      write("a", { network: "1", usePrivateMempool: "false" }),
    ]);
    expect(refused.issues[0]).toMatchObject({
      field: "usePrivateMempool",
      path: "nodes[0].data.config.usePrivateMempool",
    });
    const saved = [write("a", { network: "1", usePrivateMempool: "false" })];
    expect((await validateChains(saved, saved)).valid).toBe(true);
  });

  it("refuses sendMode and usePrivateMempool that disagree", async () => {
    const result = await validateChains([
      write("a", {
        network: "1",
        sendMode: "transaction",
        usePrivateMempool: true,
      }),
    ]);
    expect(result.issues[0]?.message).toContain("disagree");
  });

  it("keeps old (Flashbots) steps on an import", async () => {
    const batch = write(
      "a",
      { network: "1", usePrivateMempool: "true" },
      "web3/batch-write-contract"
    );
    expect((await validateChains([batch])).valid).toBe(false);
    expect(
      (await validateSendModeForSave([batch], { keepLegacy: true })).valid
    ).toBe(true);
  });
});

describe("reconcileSendModeKeys (older API clients)", () => {
  it("lets the one key the caller changed win, and writes both", () => {
    const saved = [
      write("a", {
        network: "1",
        sendMode: "private-relay",
        usePrivateMempool: true,
      }),
    ];
    const flagOnly = [
      write("a", {
        network: "1",
        sendMode: "private-relay",
        usePrivateMempool: false,
      }),
    ];
    reconcileSendModeKeys(flagOnly, saved);
    expect(flagOnly[0].data.config).toMatchObject({
      sendMode: "transaction",
      usePrivateMempool: false,
    });

    const modeOnly = [
      write("a", {
        network: "1",
        sendMode: "transaction",
        usePrivateMempool: true,
      }),
    ];
    reconcileSendModeKeys(modeOnly, saved);
    expect(modeOnly[0].data.config).toMatchObject({
      sendMode: "transaction",
      usePrivateMempool: false,
    });
  });

  it("leaves a real disagreement to be refused", async () => {
    const saved = [
      write("a", {
        network: "1",
        sendMode: "transaction",
        usePrivateMempool: false,
      }),
    ];
    const both = [
      write("a", {
        network: "1",
        sendMode: "transaction",
        usePrivateMempool: true,
        contractAddress: "0x000000000000000000000000000000000000dEaD",
        abi: '[{"type":"function","name":"run","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]',
        abiFunction: "run",
      }),
    ];
    // Only the flag changed: it wins.
    const result = await validateWorkflowNodesForSave(both, {
      savedNodes: saved,
    });
    expect(result.valid).toBe(true);
    expect((both[0].data.config as Record<string, unknown>).sendMode).toBe(
      "private-relay"
    );

    // On create there is nothing to compare with: refused.
    const fresh = [
      write("b", {
        network: "1",
        sendMode: "transaction",
        usePrivateMempool: true,
        contractAddress: "0x000000000000000000000000000000000000dEaD",
        abi: '[{"type":"function","name":"run","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]',
        abiFunction: "run",
      }),
    ];
    const refused = await validateWorkflowNodesForSave(fresh);
    expect(refused.issues.map((issue) => issue.field)).toContain("sendMode");
  });
});

const BATCH = "web3/batch-write-contract";
const LOOSE = ["false", 1, "yes", "true"];
// Every stored non-boolean shape, the falsy ones included (they run as Normal).
const STORED = [...LOOSE, 0, "", null];

describe("old non-boolean flags (sent as before: relay where there is one)", () => {
  it.each(STORED)(
    "%j on a chain without a relay passes import, autosave and an unchanged save",
    async (flag) => {
      for (const actionType of ["web3/write-contract", BATCH]) {
        const node = write(
          "a",
          { network: "8453", usePrivateMempool: flag },
          actionType
        );
        // Import and the current-draft autosave keep old steps.
        expect(
          (await validateSendModeForSave([node], { keepLegacy: true })).valid
        ).toBe(true);
        expect(
          (
            await validateSendModeForSave([node], {
              keepLegacy: true,
              savedNodes: [],
            })
          ).valid
        ).toBe(true);
        // PATCH: unchanged, or only the network moved.
        const saved = [
          write("a", { network: "1", usePrivateMempool: flag }, actionType),
        ];
        expect((await validateChains([node], saved)).valid).toBe(true);
        expect((await validateChains([node], [node])).valid).toBe(true);
      }
    }
  );

  it.each(LOOSE)(
    "%j on Ethereum reads as the relay, as before",
    async (flag) => {
      const node = write("a", { network: "1", usePrivateMempool: flag });
      expect(
        (await validateSendModeForSave([node], { keepLegacy: true })).valid
      ).toBe(true);
      // A new value through the API must be a boolean.
      expect((await validateChains([node])).issues[0]?.field).toBe(
        "usePrivateMempool"
      );
    }
  );

  it("skips the flag type check when only the network changes", async () => {
    rows.value.push({ chainId: 11_155_111, usePrivateMempoolRpc: false });
    const result = await validateChains(
      [write("a", { network: "11155111", usePrivateMempool: "true" })],
      [write("a", { network: "1", usePrivateMempool: "true" })]
    );
    expect(result.issues).toEqual([]);
  });

  it.each([0, "", null])(
    "%j on Ethereum passes import and autosave too",
    async (flag) => {
      const node = write("a", { network: "1", usePrivateMempool: flag });
      for (const options of [
        { keepLegacy: true },
        { keepLegacy: true, savedNodes: [] },
      ]) {
        expect((await validateSendModeForSave([node], options)).valid).toBe(
          true
        );
      }
    }
  );

  it("still refuses a real true on a chain without a relay", async () => {
    const node = write("a", { network: "8453", usePrivateMempool: true });
    expect(
      (await validateSendModeForSave([node], { keepLegacy: true })).issues[0]
        ?.message
    ).toContain("not available on chain 8453");
  });
});

describe("sendMode must be a known value", () => {
  it.each([
    "Private-Relay",
    "private_relay",
    " private-relay",
    true,
    "{{@x:X.mode}}",
    "bundle",
  ])("refuses %j on every save path, with one issue", async (sendMode) => {
    const node = write("a", { network: "1", sendMode });
    const direct = await validateSendModeForSave([node]);
    expect(direct.issues).toHaveLength(1);
    expect(direct.issues[0]).toMatchObject({ field: "sendMode" });
    expect(direct.issues[0].message).toContain(
      'sendMode must be "transaction" (Normal transaction) or "private-relay" (Private relay)'
    );
    for (const options of [{ keepLegacy: true }, { savedNodes: [] }, {}]) {
      const all = await validateWorkflowNodesForSave(
        [write("a", { network: "1", sendMode })],
        options
      );
      expect(
        all.issues.filter((issue) => issue.field === "sendMode")
      ).toHaveLength(1);
    }
  });

  it("gives Batch with the relay one issue that names the value to send", async () => {
    const result = await validateWorkflowNodesForSave([
      write(
        "b",
        { network: "1", sendMode: "private-relay", calls: "[]" },
        BATCH
      ),
    ]);
    const issues = result.issues.filter((issue) => issue.field === "sendMode");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(
      'Set Send as to Normal transaction (sendMode: "transaction")'
    );
  });
});
