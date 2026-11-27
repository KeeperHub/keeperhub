import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rows = vi.hoisted(() => ({
  value: [] as {
    chainId: number;
    usePrivateMempoolRpc: boolean | null;
    defaultPrivateRpcUrl?: string | null;
    builderRpcUrls?: unknown;
    name?: string;
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
      builderRpcUrls: [
        {
          label: "flashbots",
          url: "https://relay.flashbots.example",
          methods: ["bundle"],
        },
        {
          label: "titan",
          url: "https://rpc.titan.example",
          methods: ["bundle", "raw"],
        },
        // Raw only: never offered for bundles.
        { label: "rawonly", url: "https://raw.example", methods: ["raw"] },
      ],
    },
    { chainId: 8453, usePrivateMempoolRpc: false, builderRpcUrls: null },
  ];
  rows.queries = 0;
  vi.unstubAllEnvs();
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

  it("refuses sendMode private-relay on a chain without one or unknown, not the old flag alone", async () => {
    const result = await validateChains([
      write("a", { network: "8453", sendMode: "private-relay" }),
      // The old flag alone sends publicly there, as it always did.
      write("b", { network: "8453", usePrivateMempool: true }),
      write("c", { network: "999999", sendMode: "private-relay" }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "nodes[0].data.config.sendMode",
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

  it("lets a real true through on a chain without a relay: it sends publicly, as before", async () => {
    const node = write("a", { network: "8453", usePrivateMempool: true });
    for (const actionType of ["web3/write-contract", BATCH]) {
      const config = { ...node.data.config, actionType };
      const step = { ...node, data: { ...node.data, config } };
      expect((await validateChains([step])).valid).toBe(true);
    }
  });
});

describe("sendMode must be a known value", () => {
  it.each([
    "Private-Relay",
    "private_relay",
    " private-relay",
    true,
    "{{@x:X.mode}}",
    "Bundle",
  ])("refuses %j on every save path, with one issue", async (sendMode) => {
    const node = write("a", { network: "1", sendMode });
    const direct = await validateSendModeForSave([node]);
    expect(direct.issues).toHaveLength(1);
    expect(direct.issues[0]).toMatchObject({ field: "sendMode" });
    expect(direct.issues[0].message).toContain(
      'sendMode must be "transaction" (Normal transaction), "private-relay" (Private relay) or "bundle" (Bundle)'
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

  it("keeps a bundle step saved as it is", async () => {
    const saved = write("a", { network: "1", sendMode: "bundle" });
    const result = await validateSendModeForSave(
      [write("a", { network: "1", sendMode: "bundle", abiFunction: "run" })],
      { savedNodes: [saved] }
    );
    expect(result.issues).toEqual([]);
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

describe("the legacy key beside sendMode, and drafts", () => {
  // A Write Contract config the action checks accept.
  const CALL = {
    contractAddress: "0x000000000000000000000000000000000000dEaD",
    abi: '[{"type":"function","name":"run","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]',
    abiFunction: "run",
  };
  const flag = (node: { data: { config: unknown } }): unknown =>
    (node.data.config as Record<string, unknown>).usePrivateMempool;

  it("writes usePrivateMempool beside a known sendMode on every save, for older executors", async () => {
    const nodes = [
      write("a", { ...CALL, network: "1", sendMode: "private-relay" }),
      write("b", { ...CALL, network: "8453", sendMode: "transaction" }),
      write("c", { ...CALL, network: "1" }),
    ];
    const result = await validateWorkflowNodesForSave(nodes);
    expect(result.issues).toEqual([]);
    expect(nodes.map(flag)).toEqual([true, false, undefined]);
  });

  it("saves a stored key conflict left as it was, as stored; refuses it on a new network", async () => {
    const conflict = {
      network: "1",
      sendMode: "private-relay",
      usePrivateMempool: false,
    };
    const saved = [write("a", { ...CALL, ...conflict })];
    // Unchanged (another field edited): saved with both keys as stored.
    const kept = [write("a", { ...CALL, ...conflict, abiFunction: "run" })];
    const result = await validateWorkflowNodesForSave(kept, {
      savedNodes: saved,
    });
    expect(result.issues).toEqual([]);
    expect(flag(kept[0])).toBe(false);
    // A new network with the keys still in conflict is refused.
    rows.value.push({
      chainId: 11_155_111,
      usePrivateMempoolRpc: true,
      defaultPrivateRpcUrl: "https://relay.example",
    });
    const moved = [write("a", { ...CALL, ...conflict, network: "11155111" })];
    const refused = await validateWorkflowNodesForSave(moved, {
      savedNodes: saved,
    });
    expect(refused.issues[0]?.message).toContain("disagree");
    expect(flag(moved[0])).toBe(false);
  });

  it.each([
    { sendMode: "private-relay", usePrivateMempool: false },
    { sendMode: "transaction", usePrivateMempool: true },
  ])(
    "keeps the mode of a stored conflict %j over two saves from a client still holding it",
    async (conflict) => {
      let saved = [write("a", { ...CALL, network: "1", ...conflict })];
      for (const abiFunction of ["first", "second"]) {
        const abi = CALL.abi.replace('"run"', `"${abiFunction}"`);
        const nodes = [
          write("a", { ...CALL, abi, abiFunction, network: "1", ...conflict }),
        ];
        const result = await validateWorkflowNodesForSave(nodes, {
          savedNodes: saved,
        });
        expect(result.issues).toEqual([]);
        expect(nodes[0].data.config).toMatchObject(conflict);
        saved = nodes;
      }
    }
  );

  it("keeps a sent old key that agrees, and fills only a missing one", async () => {
    const saved = [
      write("a", { ...CALL, network: "1", usePrivateMempool: "true" }),
    ];
    // sendMode added to a stored loose flag: the flag stays as sent.
    const nodes = [
      write("a", {
        ...CALL,
        network: "1",
        sendMode: "private-relay",
        usePrivateMempool: "true",
      }),
    ];
    const result = await validateWorkflowNodesForSave(nodes, {
      savedNodes: saved,
    });
    expect(result.issues).toEqual([]);
    expect(flag(nodes[0])).toBe("true");
  });

  it("keeps a step saved with sendMode alone unchanged after its chain loses the relay", async () => {
    // Saved through the API with sendMode alone: the server filled the flag.
    const sent = [
      write("a", { ...CALL, network: "1", sendMode: "private-relay" }),
    ];
    expect((await validateWorkflowNodesForSave(sent)).issues).toEqual([]);
    const stored = structuredClone(sent);
    expect(flag(stored[0])).toBe(true);
    // The relay is turned off for chain 1, then the client resends its own copy.
    rows.value = [{ chainId: 1, usePrivateMempoolRpc: false }];
    const resent = [
      write("a", { ...CALL, network: "1", sendMode: "private-relay" }),
    ];
    const result = await validateWorkflowNodesForSave(resent, {
      savedNodes: stored,
    });
    expect(result.issues).toEqual([]);
    expect(flag(resent[0])).toBe(true);
    // Only the server's own fill counts as unchanged: a stored loose flag does not.
    const loose = [
      write("a", {
        ...CALL,
        network: "1",
        sendMode: "private-relay",
        usePrivateMempool: "true",
      }),
    ];
    const changed = await validateWorkflowNodesForSave(
      [write("a", { ...CALL, network: "1", sendMode: "private-relay" })],
      { savedNodes: loose }
    );
    expect(changed.issues[0]?.message).toContain("not available on chain 1");
  });

  it("saves a stored unknown sendMode left as it was; refuses a new one", async () => {
    const unknown = { network: "1", sendMode: "Private-Relay" };
    const saved = [write("a", { ...CALL, ...unknown })];
    const kept = [write("a", { ...CALL, ...unknown })];
    const result = await validateWorkflowNodesForSave(kept, {
      savedNodes: saved,
    });
    expect(result.issues).toEqual([]);
    expect(flag(kept[0])).toBeUndefined();
    const fresh = [write("b", { ...CALL, ...unknown })];
    expect((await validateWorkflowNodesForSave(fresh)).valid).toBe(false);
  });

  it("writes nothing when the save is refused", async () => {
    const nodes = [
      write("a", { ...CALL, network: "8453", sendMode: "private-relay" }),
    ];
    const result = await validateWorkflowNodesForSave(nodes);
    expect(result.valid).toBe(false);
    expect(flag(nodes[0])).toBeUndefined();
  });

  it("lets a draft keep only old values its stored copy already had", async () => {
    // As the current-draft autosave calls it: the stored draft, no keepLegacy.
    const stored = [
      write("kept", { ...CALL, network: "1", usePrivateMempool: "yes" }),
      write("batch", { network: "1", usePrivateMempool: true }, BATCH),
    ];
    const kept = await validateSendModeForSave(
      [
        write("kept", {
          ...CALL,
          network: "1",
          usePrivateMempool: "yes",
          abiFunction: "other",
        }),
        write("batch", { network: "8453", usePrivateMempool: true }, BATCH),
      ],
      { savedNodes: stored }
    );
    expect(kept.issues).toEqual([]);

    for (const node of [
      write("new1", { ...CALL, network: "1", usePrivateMempool: "yes" }),
      write("new2", {
        ...CALL,
        network: "1",
        usePrivateMempool: "{{@trigger:Webhook.private}}",
      }),
      write("new3", { network: "1", usePrivateMempool: true }, BATCH),
    ]) {
      const fresh = await validateSendModeForSave([node], {
        savedNodes: stored,
      });
      expect(fresh.valid).toBe(false);
    }
  });
});

describe("Send as Bundle at save", () => {
  const ORG = "org-in";
  const enable = (): void => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", `orgs:${ORG}`);
  };
  const bundle = (config: Record<string, unknown> = {}, action?: string) =>
    write("a", { network: "1", sendMode: "bundle", ...config }, action);
  const check = (
    nodes: Parameters<typeof validateSendModeForSave>[0],
    options: Parameters<typeof validateSendModeForSave>[1] = {}
  ) => validateSendModeForSave(nodes, { organizationId: ORG, ...options });

  it("accepts a Write Contract bundle step for an organization in the rollout", async () => {
    enable();
    const result = await check([
      bundle({
        bundleBlocks: "3",
        bundleTipIncreasePercent: 20,
        bundleBuilders: ["titan"],
      }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it("refuses an organization outside the rollout, naming the label and the value", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "orgs:someone-else");
    const result = await check([bundle()]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ field: "sendMode" });
    expect(result.issues[0].message).toBe(
      'Send as: Bundle (sendMode "bundle") is not turned on for this organization yet. Set Send as to Normal transaction (sendMode: "transaction").'
    );
  });

  it("refuses without an organization, and with the rollout off", async () => {
    enable();
    const none = await validateSendModeForSave([bundle()]);
    expect(none.issues[0].message).toContain("not turned on");
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "off");
    expect((await check([bundle()])).issues).toHaveLength(1);
  });

  it("keeps a step saved as a bundle saving after the rollout is turned off", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "off");
    const saved = bundle({ bundleBlocks: "3" });
    const edited = bundle({ bundleBlocks: "2", abiFunction: "run" });
    expect((await check([edited], { savedNodes: [saved] })).issues).toEqual([]);
    // Its settings are still checked.
    const broken = await check([bundle({ bundleBlocks: "9" })], {
      savedNodes: [saved],
    });
    expect(broken.issues[0]).toMatchObject({ field: "bundleBlocks" });
  });

  it("with the rollout off, lets a bundle step through as saved when only the server-filled flag differs", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "off");
    // Stored with a Safe connection: any re-check would refuse it.
    const saved = bundle({
      usePrivateMempool: false,
      web3Connection: "safe:0xabc",
    });
    const same = await check(
      [bundle({ web3Connection: "safe:0xabc", abiFunction: "run" })],
      { savedNodes: [saved] }
    );
    expect(same.issues).toEqual([]);
    expect(rows.queries).toBe(0);
  });

  it("with the rollout off, a bundle step whose connection alone changed is checked again", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "off");
    const saved = bundle({
      usePrivateMempool: false,
      web3Connection: "safe:0xabc",
    });
    const moved = await check([bundle({ web3Connection: "safe:0xdef" })], {
      savedNodes: [saved],
    });
    expect(moved.issues).toHaveLength(1);
    expect(moved.issues[0]).toMatchObject({ field: "web3Connection" });
  });

  it.each([
    ["web3/transfer-funds"],
    ["web3/batch-write-contract"],
    ["web3/approve-token"],
  ])("refuses %s, which cannot bundle", async (action) => {
    enable();
    const result = await check([bundle({}, action)]);
    expect(result.issues).toHaveLength(1);
    // Said once: the mode, where it works, and the fix.
    expect(result.issues[0].message).toBe(
      'Bundle (sendMode: "bundle") is only available on Write Contract steps. Set Send as to Normal transaction (sendMode: "transaction").'
    );
  });

  it("refuses direct execution even in the rollout", async () => {
    enable();
    const result = await check([bundle()], { direct: true });
    expect(result.issues[0].message).toContain(
      "only runs in a Write Contract step of a workflow, not through direct execution"
    );
  });

  it("refuses a Safe connection on the web3Connection field", async () => {
    enable();
    const result = await check([bundle({ web3Connection: "safe:abc" })]);
    expect(result.issues[0]).toMatchObject({ field: "web3Connection" });
    expect(result.issues[0].message).toBe(
      'web3Connection "safe:...": Send as Bundle cannot send through a Safe or Roles connection yet. Use your wallet (EOA) connection, or set Send as to Normal transaction (sendMode: "transaction").'
    );
  });

  it.each([
    [{ bundleBlocks: 0 }, "bundleBlocks", "Target blocks (bundleBlocks)"],
    [{ bundleBlocks: "6" }, "bundleBlocks", "Target blocks (bundleBlocks)"],
    [
      { bundleBlocks: "{{@n:N.x}}" },
      "bundleBlocks",
      "Target blocks (bundleBlocks)",
    ],
    [
      { bundleTipIncreasePercent: 101 },
      "bundleTipIncreasePercent",
      "Tip increase per block (%) (bundleTipIncreasePercent)",
    ],
    [
      { bundleBuilders: "titan" },
      "bundleBuilders",
      "Builders (bundleBuilders)",
    ],
  ])("refuses %j on its own field", async (config, field, label) => {
    enable();
    const result = await check([bundle(config)]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ field });
    expect(result.issues[0].message).toContain(label);
  });

  it("refuses a chain without builders", async () => {
    enable();
    const result = await check([bundle({ network: "8453" })]);
    expect(result.issues[0].message).toBe(
      'Send as: Bundle (sendMode "bundle") is not available on chain 8453: it has no block builders that take bundles. Set Send as to Normal transaction (sendMode: "transaction").'
    );
  });

  it("names the network by its name when the chain row has one", async () => {
    enable();
    rows.value = [
      {
        chainId: 8453,
        name: "Base",
        usePrivateMempoolRpc: false,
        builderRpcUrls: null,
      },
    ];
    const result = await check([bundle({ network: "8453" })]);
    expect(result.issues[0].message).toContain(
      "is not available on Base: it has no block builders that take bundles."
    );
  });

  it("validate_workflow (recheckBundles) re-checks saved bundle steps only", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "off");
    const nodes = [
      bundle(),
      // Saved before, and run as stored: a key conflict and an old non-boolean flag.
      write("conflict", {
        network: "1",
        sendMode: "transaction",
        usePrivateMempool: true,
      }),
      write("legacy", { network: "1", usePrivateMempool: "true" }),
    ];
    const result = await check(nodes, {
      savedNodes: nodes,
      recheckBundles: true,
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ nodeId: "a", field: "sendMode" });
    expect(result.issues[0].message).toContain("not turned on");
  });

  it("refuses builder names the chain does not list, and lists the ones it does", async () => {
    enable();
    const result = await check([bundle({ bundleBuilders: ["titan", "gone"] })]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ field: "bundleBuilders" });
    expect(result.issues[0].message).toContain(
      'does not list: "gone". Pick from: flashbots, titan'
    );
  });

  it("refuses a raw-only builder for a bundle", async () => {
    enable();
    const result = await check([bundle({ bundleBuilders: ["rawonly"] })]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain(
      'does not list: "rawonly". Pick from: flashbots, titan'
    );
  });

  it("cuts a long unknown builder name short in the message", async () => {
    enable();
    const long = "x".repeat(500);
    const result = await check([bundle({ bundleBuilders: [long] })]);
    expect(result.issues[0].message).not.toContain(long);
    expect(result.issues[0].message).toContain(`"${"x".repeat(39)}...`);
    // `received` echoes only the unknown names, cut short too.
    expect(result.issues[0].received).toEqual([`${"x".repeat(40)}...`]);
  });

  it("a copy says why the step cannot run, without advice the copier cannot act on", async () => {
    const copy = async (nodes: ReturnType<typeof bundle>[]) =>
      (
        await check(nodes, {
          savedNodes: nodes,
          recheckBundles: true,
          copy: true,
        })
      ).issues.map((issue) => issue.message);
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "off");
    expect(await copy([bundle()])).toEqual([
      'Send as: Bundle (sendMode "bundle") cannot run in your organization: bundles are not turned on for it yet.',
    ]);
    enable();
    expect(await copy([bundle({ network: "8453" })])).toEqual([
      'Send as: Bundle (sendMode "bundle") cannot run on chain 8453: it has no block builders that take bundles.',
    ]);
    expect(await copy([bundle({ bundleBuilders: ["gone"] })])).toEqual([
      'Send as: Bundle (sendMode "bundle") cannot run: chain 1 lists none of its builders ("gone").',
    ]);
    for (const message of [
      ...(await copy([bundle({ network: "8453" })])),
      ...(await copy([bundle({ bundleBuilders: ["gone"] })])),
    ]) {
      expect(message).not.toContain("Normal transaction");
    }
  });

  it("recheck holds a stored step to the run-time builder rule: refused only when none is listed", async () => {
    enable();
    const partly = [bundle({ bundleBuilders: ["titan", "gone"] })];
    expect(
      (await check(partly, { savedNodes: partly, recheckBundles: true })).issues
    ).toEqual([]);
    const none = [bundle({ bundleBuilders: ["gone"] })];
    const result = await check(none, {
      savedNodes: none,
      recheckBundles: true,
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ field: "bundleBuilders" });
    // A step changed since it was saved stays strict.
    const changed = await check(partly, {
      savedNodes: [bundle({ bundleBuilders: ["titan"] })],
      recheckBundles: true,
    });
    expect(changed.issues).toHaveLength(1);
  });

  it("checks a templated network's builders at run time only", async () => {
    enable();
    const result = await check([
      bundle({ network: "{{@t:T.chain}}", bundleBuilders: ["anything"] }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it("refuses a bundle step in a For Each nested in another, but not in one", async () => {
    enable();
    const forEach = (id: string) => ({
      id,
      type: "action",
      data: {
        type: "action",
        label: id,
        config: { actionType: "For Each", arraySource: "[]" },
      },
    });
    const nodes = [forEach("outer"), forEach("inner"), bundle()];
    const nested = [
      { id: "e1", source: "outer", target: "inner", sourceHandle: "loop" },
      { id: "e2", source: "inner", target: "a", sourceHandle: "loop" },
    ];
    const refused = await check(nodes, { edges: nested });
    expect(refused.issues).toHaveLength(1);
    expect(refused.issues[0].message).toContain(
      "cannot run inside a For Each that is inside another For Each"
    );
    // Refused on an unchanged saved step too: the rule is not new.
    const kept = await check(nodes, { edges: nested, savedNodes: nodes });
    expect(kept.issues).toHaveLength(1);

    const single = [
      { id: "e1", source: "outer", target: "a", sourceHandle: "loop" },
    ];
    expect((await check(nodes, { edges: single })).issues).toEqual([]);
  });
});
