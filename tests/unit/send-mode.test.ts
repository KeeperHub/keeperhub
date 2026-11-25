import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  availableSendModes,
  isLegacyPrivateRelayConfig,
  legacyFlagTypeIssue,
  type RelayUse,
  relayUseOf,
  resolveSendMode,
  SEND_MODE,
  type SendMode,
  sendModeConflict,
  sendModeOn,
  unknownSendModeIssue,
  unsupportedSendMode,
  usesPrivateRelay,
} from "@/lib/web3/send-mode";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  chooseNetwork,
  editorSendMode,
  hasSendModeField,
  networkChangeNotice,
  pickSendMode,
  SPONSOR_ON_NOTICE,
  sendModeWarning,
  sendsPrivately,
  shownSponsorGas,
  switchSponsorGas,
} from "@/lib/workflow/editor/send-mode-editor";
import { wouldBeSponsored } from "@/lib/workflow/editor/show-when";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import {
  findActionById,
  flattenConfigFields,
  getAllActions,
} from "@/plugins/registry";

const RELAY_CHAIN = { usePrivateMempoolRpc: true };
const PLAIN_CHAIN = { usePrivateMempoolRpc: false };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveSendMode", () => {
  it.each([
    [{}, SEND_MODE.TRANSACTION],
    [{ usePrivateMempool: false }, SEND_MODE.TRANSACTION],
    [{ usePrivateMempool: true }, SEND_MODE.PRIVATE_RELAY],
    [{ usePrivateMempool: "true" }, SEND_MODE.PRIVATE_RELAY],
    // Old stored values read as the old runtime did: truthy is the relay.
    [{ usePrivateMempool: "false" }, SEND_MODE.PRIVATE_RELAY],
    [{ usePrivateMempool: 1 }, SEND_MODE.PRIVATE_RELAY],
    [{ usePrivateMempool: "yes" }, SEND_MODE.PRIVATE_RELAY],
    [{ usePrivateMempool: "" }, SEND_MODE.TRANSACTION],
    [{ usePrivateMempool: 0 }, SEND_MODE.TRANSACTION],
    [{ usePrivateMempool: null }, SEND_MODE.TRANSACTION],
    [{ sendMode: "private-relay" }, SEND_MODE.PRIVATE_RELAY],
    [{ sendMode: "transaction", usePrivateMempool: false }, "transaction"],
    [{ sendMode: "bogus", usePrivateMempool: true }, SEND_MODE.PRIVATE_RELAY],
    [{ sendMode: "bogus" }, SEND_MODE.TRANSACTION],
  ])("reads %j as %s", (config, mode) => {
    expect(resolveSendMode(config)).toBe(mode);
    expect(usesPrivateRelay(config)).toBe(mode === SEND_MODE.PRIVATE_RELAY);
  });

  it("calls only a flag-only config legacy", () => {
    expect(isLegacyPrivateRelayConfig({ usePrivateMempool: true })).toBe(true);
    expect(
      isLegacyPrivateRelayConfig({
        sendMode: "private-relay",
        usePrivateMempool: true,
      })
    ).toBe(false);
    expect(isLegacyPrivateRelayConfig({ usePrivateMempool: false })).toBe(
      false
    );
  });

  it("lists the private relay only on a chain that has one", () => {
    expect(availableSendModes(RELAY_CHAIN).map((o) => o.value)).toEqual([
      "transaction",
      "private-relay",
    ]);
    expect(availableSendModes(PLAIN_CHAIN).map((o) => o.value)).toEqual([
      "transaction",
    ]);
    expect(availableSendModes(undefined).map((o) => o.value)).toEqual([
      "transaction",
    ]);
  });

  it("flags sendMode and usePrivateMempool that disagree", () => {
    expect(sendModeConflict({ sendMode: "transaction" })).toBeUndefined();
    expect(
      sendModeConflict({ sendMode: "private-relay", usePrivateMempool: true })
    ).toBeUndefined();
    expect(
      sendModeConflict({ sendMode: "transaction", usePrivateMempool: true })
    ).toContain("disagree");
    expect(
      sendModeConflict({ sendMode: "private-relay", usePrivateMempool: false })
    ).toBe(
      'sendMode "private-relay" and usePrivateMempool false disagree. Send sendMode alone, or pair usePrivateMempool: true with "private-relay" and usePrivateMempool: false with "transaction".'
    );
  });

  it("asks new values of the legacy flag to be booleans", () => {
    expect(legacyFlagTypeIssue(undefined)).toBeUndefined();
    expect(legacyFlagTypeIssue(true)).toBeUndefined();
    expect(legacyFlagTypeIssue("false")).toContain(
      'usePrivateMempool must be true or false, not "false"'
    );
  });
});

describe("which steps have Send as", () => {
  const withSendAs = getAllActions()
    .filter((action) =>
      flattenConfigFields(action.configFields).some(
        (field) => field.key === "sendMode"
      )
    )
    .map((action) => action.id);

  it.each([
    "web3/write-contract",
    "web3/batch-write-contract",
    "web3/transfer-funds",
    "web3/transfer-token",
    "web3/approve-token",
  ])("%s has it, right under Network", (id) => {
    const fields = findActionById(id)?.configFields ?? [];
    const keys = fields.map((field) => ("key" in field ? field.key : ""));
    expect(keys.indexOf("sendMode")).toBe(keys.indexOf("network") + 1);
  });

  it("offers no private relay on Batch Write Contract yet", () => {
    const field = flattenConfigFields(
      findActionById("web3/batch-write-contract")?.configFields ?? []
    ).find((candidate) => candidate.key === "sendMode");
    expect(field?.options?.map((option) => option.value)).toEqual([
      "transaction",
    ]);
    expect(
      unsupportedSendMode("web3/batch-write-contract", "private-relay")
    ).toContain("can't send through the private relay yet");
    expect(
      unsupportedSendMode("web3/write-contract", "private-relay")
    ).toBeUndefined();
  });

  it("is on every protocol write action and no read", () => {
    const protocolWrites = getAllActions().filter(
      (action) =>
        action.integration !== "web3" &&
        flattenConfigFields(action.configFields).some(
          (field) => field.key === "sponsorGas"
        )
    );
    expect(protocolWrites.length).toBeGreaterThan(10);
    for (const action of protocolWrites) {
      expect(withSendAs).toContain(action.id);
    }
    expect(withSendAs).not.toContain("web3/read-contract");
    expect(withSendAs).not.toContain("web3/transfer-spl-token");
  });
});

describe("editor rules", () => {
  const write = {
    actionType: "web3/write-contract",
    network: "1",
  };

  it("turns Sponsor gas off when a non-Normal choice is picked", () => {
    const change = pickSendMode(write, "private-relay");
    expect(change.writes).toEqual([
      ["sendMode", "private-relay"],
      ["usePrivateMempool", true],
      ["sponsorGas", false],
    ]);
    expect(change.notice).toContain("Sponsor gas turned off");
    expect(change.undo).toEqual([
      ["sendMode", undefined],
      ["usePrivateMempool", undefined],
      ["sponsorGas", undefined],
    ]);
  });

  it("leaves Sponsor gas alone when already off or not shown", () => {
    expect(
      pickSendMode({ ...write, sponsorGas: false }, "private-relay").notice
    ).toBeUndefined();
    // Batch Write Contract has no Sponsor gas.
    expect(
      pickSendMode(
        { actionType: "web3/batch-write-contract", network: "1" },
        "private-relay"
      ).writes
    ).toEqual([
      ["sendMode", "private-relay"],
      ["usePrivateMempool", true],
    ]);
  });

  it("sets Send as to Normal when Sponsor gas is turned back on", () => {
    const config = {
      ...write,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: false,
    };
    const change = switchSponsorGas(config, true);
    expect(change.writes).toEqual([
      ["sponsorGas", true],
      ["sendMode", "transaction"],
      ["usePrivateMempool", false],
    ]);
    expect(change.notice).toBe(SPONSOR_ON_NOTICE);
    expect(change.undo).toEqual([
      ["sponsorGas", false],
      ["sendMode", "private-relay"],
      ["usePrivateMempool", true],
    ]);
  });

  it("also maps a legacy config back to Normal, Sponsor gas unset included", () => {
    const change = switchSponsorGas(
      { ...write, usePrivateMempool: true, sponsorGas: false },
      true
    );
    expect(change.notice).toBe(SPONSOR_ON_NOTICE);
    // Shown off while Send as is not Normal, so turning it on is a change.
    const legacy = { ...write, usePrivateMempool: true };
    expect(shownSponsorGas(legacy)).toBe(false);
    expect(shownSponsorGas(write)).toBeUndefined();
    expect(switchSponsorGas(legacy, true).notice).toBe(SPONSOR_ON_NOTICE);
  });

  it("brings back the fees turning sponsorship on clears, on Undo", () => {
    const change = switchSponsorGas(
      {
        ...write,
        sendMode: "private-relay",
        usePrivateMempool: true,
        sponsorGas: false,
        priorityFeeGwei: "3",
      },
      true
    );
    expect(change.undo).toEqual([
      ["sponsorGas", false],
      ["sendMode", "private-relay"],
      ["usePrivateMempool", true],
    ]);
    expect(change.restoreIfCleared).toEqual([["priorityFeeGwei", "3"]]);
  });

  it("changes nothing else when Sponsor gas is turned off", () => {
    const change = switchSponsorGas(
      { ...write, sendMode: "transaction" },
      false
    );
    expect(change.writes).toEqual([["sponsorGas", false]]);
    expect(change.notice).toBeUndefined();
  });

  it("falls back to Normal on a network without the relay, with Undo", () => {
    const config = { ...write, sendMode: "private-relay", maxFeeGwei: "40" };
    const base = { chainId: 8453, name: "Base", ...PLAIN_CHAIN };
    const change = chooseNetwork(config, base, "network");
    // Sponsor gas showed off and was never set: it stays off.
    expect(change.writes).toEqual([
      ["sendMode", "transaction"],
      ["usePrivateMempool", false],
      ["sponsorGas", false],
    ]);
    expect(change.undo).toEqual([
      ["network", "1"],
      ["sendMode", "private-relay"],
      ["usePrivateMempool", undefined],
      ["sponsorGas", undefined],
    ]);
    // The notice lasts only while the network it names is still picked.
    expect(change.wrote).toEqual([["network", "8453"], ...change.writes]);
    // A reset that makes the step sponsored clears fees; Undo puts them back.
    expect(change.restoreIfCleared).toEqual([["maxFeeGwei", "40"]]);
    expect(change.notice).toBe(
      "Send as changed to Normal transaction (public mempool): Base has no private relay."
    );
    const ethereum = { chainId: 1, name: "Ethereum", ...RELAY_CHAIN };
    // Nothing to change, no notice: the pick still clears an older notice.
    for (const quiet of [
      chooseNetwork(config, ethereum, "network"),
      chooseNetwork(write, base, "network"),
      // Only the Send as field's own network field resets it.
      chooseNetwork(config, base, "otherChain"),
      chooseNetwork(
        { actionType: "web3/read-contract", usePrivateMempool: true },
        base,
        "network"
      ),
    ]) {
      expect(quiet.writes).toEqual([]);
      expect(quiet.notice).toBeUndefined();
    }
    expect(networkChangeNotice()).toBe(
      "Send as changed to Normal transaction (public mempool): this network has no private relay."
    );
  });

  it("keeps Sponsor gas off when an old relay step with it unset goes Normal", () => {
    const legacy = { ...write, usePrivateMempool: true };
    expect(pickSendMode(legacy, "transaction").writes).toEqual([
      ["sendMode", "transaction"],
      ["usePrivateMempool", false],
      ["sponsorGas", false],
    ]);
    const base = { chainId: 8453, name: "Base", ...PLAIN_CHAIN };
    expect(chooseNetwork(legacy, base, "network").writes).toContainEqual([
      "sponsorGas",
      false,
    ]);
    // A value the user set is left alone.
    expect(
      pickSendMode({ ...legacy, sponsorGas: true }, "transaction").writes
    ).toEqual([
      ["sendMode", "transaction"],
      ["usePrivateMempool", false],
    ]);
  });

  it("drops a Send as the new step cannot use when the action changes", () => {
    const next = buildConfigForActionTypeChange("web3/batch-write-contract", {
      ...write,
      sendMode: "private-relay",
      usePrivateMempool: true,
    });
    expect(next).toMatchObject({
      sendMode: "transaction",
      usePrivateMempool: false,
    });
    expect(
      buildConfigForActionTypeChange("web3/transfer-funds", {
        ...write,
        sendMode: "private-relay",
      })
    ).toMatchObject({ sendMode: "private-relay" });
  });

  it("shows the badge only where the node sends privately", () => {
    expect(sendsPrivately({ ...write, sendMode: "private-relay" })).toBe(true);
    expect(sendsPrivately(write)).toBe(false);
    expect(
      sendsPrivately({
        actionType: "web3/batch-write-contract",
        usePrivateMempool: true,
      })
    ).toBe(false);
  });

  it("knows which nodes have the field", () => {
    expect(hasSendModeField(write)).toBe(true);
    expect(hasSendModeField({ actionType: "web3/read-contract" })).toBe(false);
    expect(hasSendModeField({})).toBe(false);
  });

  it("is never sponsored unless sent as Normal", () => {
    expect(wouldBeSponsored(write, "network")).toBe(true);
    expect(
      wouldBeSponsored({ ...write, sendMode: "private-relay" }, "network")
    ).toBe(false);
    expect(
      wouldBeSponsored({ ...write, usePrivateMempool: true }, "network")
    ).toBe(false);
  });
});

describe("save-time validation (action configs)", () => {
  function node(config: Record<string, unknown>) {
    return {
      id: "w1",
      type: "action",
      data: {
        type: "action",
        label: "Write",
        config: {
          actionType: "web3/write-contract",
          network: "1",
          contractAddress: "0x000000000000000000000000000000000000dEaD",
          abi: '[{"type":"function","name":"run","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]',
          abiFunction: "run",
          ...config,
        },
      },
    };
  }

  it.each([
    {},
    { sendMode: "transaction" },
    { sendMode: "private-relay" },
    { usePrivateMempool: true },
    { sendMode: "private-relay", usePrivateMempool: true },
    { sendMode: "transaction", usePrivateMempool: false },
  ])("accepts %j", (config) => {
    expect(validateWorkflowActionConfigs([node(config)]).valid).toBe(true);
  });

  it("leaves sendMode to the Send as check (one issue per node)", () => {
    const batchNode = {
      id: "b1",
      type: "action",
      data: {
        type: "action",
        label: "Batch",
        config: {
          actionType: "web3/batch-write-contract",
          network: "1",
          calls: "[]",
          sendMode: "private-relay",
        },
      },
    };
    const issues = validateWorkflowActionConfigs([
      node({ sendMode: "bundle" }),
      batchNode,
    ]).issues.filter((issue) => issue.field === "sendMode");
    expect(issues).toEqual([]);
  });
});

// Every legacy value shape, on a chain with a relay (Ethereum) and without (Base).
const ETHEREUM = { chainId: 1, name: "Ethereum", usePrivateMempoolRpc: true };
const BASE = { chainId: 8453, name: "Base", usePrivateMempoolRpc: false };
type Shape = [string, Record<string, unknown>, SendMode, SendMode, RelayUse];
const SHAPES: Shape[] = [
  // [name, keys, mode on Ethereum, mode on Base, run-time relay use]
  [
    "true",
    { usePrivateMempool: true },
    "private-relay",
    "private-relay",
    "required",
  ],
  [
    '"false"',
    { usePrivateMempool: "false" },
    "private-relay",
    "transaction",
    "if-available",
  ],
  [
    "1",
    { usePrivateMempool: 1 },
    "private-relay",
    "transaction",
    "if-available",
  ],
  [
    '"yes"',
    { usePrivateMempool: "yes" },
    "private-relay",
    "transaction",
    "if-available",
  ],
  [
    '"true"',
    { usePrivateMempool: "true" },
    "private-relay",
    "transaction",
    "if-available",
  ],
  ["0", { usePrivateMempool: 0 }, "transaction", "transaction", "none"],
  ['""', { usePrivateMempool: "" }, "transaction", "transaction", "none"],
  ["null", { usePrivateMempool: null }, "transaction", "transaction", "none"],
  ["false", { usePrivateMempool: false }, "transaction", "transaction", "none"],
  [
    "sendMode relay",
    { sendMode: "private-relay" },
    "private-relay",
    "private-relay",
    "required",
  ],
  [
    "sendMode null + true",
    { sendMode: null, usePrivateMempool: true },
    "private-relay",
    "private-relay",
    "required",
  ],
];

describe("old flag values across chains", () => {
  afterEach(() => setEditorSendModeChains(undefined));

  it.each(SHAPES)(
    "%s reads by the chain, the same everywhere",
    (_name, keys, onEth, onBase, relay) => {
      expect(sendModeOn(keys, ETHEREUM)).toBe(onEth);
      expect(sendModeOn(keys, BASE)).toBe(onBase);
      expect(relayUseOf(keys)).toBe(relay);

      // The editor reads it the same once the chain list is known.
      setEditorSendModeChains([ETHEREUM, BASE]);
      for (const [network, mode] of [
        ["1", onEth],
        ["8453", onBase],
      ] as const) {
        const config = { actionType: "web3/write-contract", network, ...keys };
        expect(editorSendMode(config)).toBe(mode);
        const isPrivate = mode !== "transaction";
        // No badge where the step fails before sending (no relay on Base).
        expect(sendsPrivately(config)).toBe(isPrivate && network === "1");
        expect(shownSponsorGas(config)).toBe(isPrivate ? false : undefined);
        expect(wouldBeSponsored(config, "network")).toBe(!isPrivate);
        // Batch keeps a Normal-reading node as it is, and resets a relay one.
        const batch = buildConfigForActionTypeChange(
          "web3/batch-write-contract",
          config
        );
        expect(resolveSendMode(batch) === "private-relay").toBe(
          !isPrivate && resolveSendMode(keys) === "private-relay"
        );
      }
    }
  );

  it("never turns the relay on unseen when an old flag moves network", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const onBase = {
      actionType: "web3/write-contract",
      network: "8453",
      usePrivateMempool: "false",
    };
    const toEthereum = chooseNetwork(onBase, ETHEREUM, "network");
    expect(toEthereum.writes).toEqual([
      ["sendMode", "transaction"],
      ["usePrivateMempool", false],
    ]);
    expect(toEthereum.notice).toBeUndefined();
    // From Ethereum (shown Private relay) to Base: Normal, with a notice.
    const toBase = chooseNetwork({ ...onBase, network: "1" }, BASE, "network");
    expect(toBase.writes.slice(0, 2)).toEqual([
      ["sendMode", "transaction"],
      ["usePrivateMempool", false],
    ]);
    expect(toBase.notice).toContain("Base has no private relay");
  });
});

describe("before the chain list is known", () => {
  afterEach(() => setEditorSendModeChains(undefined));

  it("keeps an old non-boolean flag neutral: no badge, Sponsor gas as stored", () => {
    setEditorSendModeChains(undefined);
    for (const flag of ["false", 1, "yes", "true"]) {
      const config = {
        actionType: "web3/write-contract",
        network: "8453",
        usePrivateMempool: flag,
        sponsorGas: true,
      };
      expect(editorSendMode(config)).toBe("transaction");
      expect(sendsPrivately(config)).toBe(false);
      expect(shownSponsorGas(config)).toBe(true);
    }
    // A real choice of the relay still shows as one.
    const chosen = {
      actionType: "web3/write-contract",
      network: "1",
      usePrivateMempool: true,
    };
    expect(sendsPrivately(chosen)).toBe(true);
    expect(shownSponsorGas(chosen)).toBe(false);
  });

  it("reads saved network names like the run does", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const old = {
      actionType: "web3/write-contract",
      usePrivateMempool: "false",
    };
    expect(editorSendMode({ ...old, network: "base" })).toBe("transaction");
    expect(editorSendMode({ ...old, network: "mainnet" })).toBe(
      "private-relay"
    );
    expect(sendsPrivately({ ...old, network: "base" })).toBe(false);
    // A template network stays unknown: neutral.
    expect(editorSendMode({ ...old, network: "{{@x:X.chain}}" })).toBe(
      "transaction"
    );
  });
});

describe("canvas marker for a step Send as stops", () => {
  afterEach(() => setEditorSendModeChains(undefined));

  const BATCH = "web3/batch-write-contract";
  const WRITE = "web3/write-contract";
  // [name, config, fails before sending, PRIVATE badge]
  const NODES: [string, Record<string, unknown>, boolean, boolean][] = [
    [
      "true on Base",
      { actionType: WRITE, network: "8453", usePrivateMempool: true },
      true,
      false,
    ],
    [
      "relay on Base",
      { actionType: WRITE, network: "8453", sendMode: "private-relay" },
      true,
      false,
    ],
    [
      "Batch relay on Ethereum",
      { actionType: BATCH, network: "1", sendMode: "private-relay" },
      true,
      false,
    ],
    [
      "Batch true on Base",
      { actionType: BATCH, network: "8453", usePrivateMempool: true },
      true,
      false,
    ],
    [
      "Batch old flag on Ethereum",
      { actionType: BATCH, network: "1", usePrivateMempool: "false" },
      true,
      false,
    ],
    [
      "Batch relay strict: false",
      {
        actionType: BATCH,
        network: "1",
        usePrivateMempool: true,
        strict: false,
      },
      true,
      false,
    ],
    [
      "relay on Base, strict: false (sends publicly)",
      {
        actionType: WRITE,
        network: "8453",
        sendMode: "private-relay",
        strict: false,
      },
      false,
      false,
    ],
    [
      "old flag on Base (Normal)",
      { actionType: WRITE, network: "8453", usePrivateMempool: "false" },
      false,
      false,
    ],
    [
      "Batch old flag on Base (Normal)",
      { actionType: BATCH, network: "8453", usePrivateMempool: "false" },
      false,
      false,
    ],
    [
      "relay on Ethereum",
      { actionType: WRITE, network: "1", sendMode: "private-relay" },
      false,
      true,
    ],
    [
      "true on Ethereum",
      { actionType: WRITE, network: "1", usePrivateMempool: true },
      false,
      true,
    ],
    ["Normal", { actionType: WRITE, network: "1" }, false, false],
  ];

  it.each(NODES)("%s", (_name, config, fails, badge) => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    expect(sendModeWarning(config)?.fails === true).toBe(fails);
    expect(sendsPrivately(config)).toBe(badge);
    // Never both a warning marker and the PRIVATE badge.
    expect(fails && badge).toBe(false);
  });
});

describe("unknown sendMode values", () => {
  it.each([
    "Private-Relay",
    "PRIVATE-RELAY",
    "private_relay",
    " private-relay",
    "private-relay ",
    "bundle",
    "{{@x:X.mode}}",
    true,
    1,
  ])("refuses %j", (value) => {
    expect(unknownSendModeIssue(value)).toBe(
      `sendMode must be "transaction" (Normal transaction) or "private-relay" (Private relay), not ${JSON.stringify(value)}.`
    );
  });

  it.each([undefined, null, "", "transaction", "private-relay"])(
    "lets %j through",
    (value) => {
      expect(unknownSendModeIssue(value)).toBeUndefined();
    }
  );
});
