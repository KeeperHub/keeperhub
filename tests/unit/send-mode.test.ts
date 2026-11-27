import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  availableSendModes,
  isLegacyPrivateRelayConfig,
  legacyFlagTypeIssue,
  relayUseOf,
  resolveSendMode,
  SEND_MODE,
  type SendMode,
  sendModeConflict,
  unknownSendModeIssue,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  actionSwitchNotice,
  chooseNetwork,
  editorSendMode,
  hasSendModeField,
  pickChanges,
  pickSendMode,
  sendModeWarning,
  sendsPrivately,
  shownSponsorGas,
  switchSponsorGas,
  untouchedSinceSwitch,
} from "@/lib/workflow/editor/send-mode-editor";
import { wouldBeSponsored } from "@/lib/workflow/editor/show-when";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import {
  findActionById,
  flattenConfigFields,
  getAllActions,
} from "@/plugins/registry";

const RELAY_CHAIN = { usePrivateMempoolRpc: true };
const SPONSOR_ON_NOTICE =
  "Send as changed to Normal transaction (public mempool): only normal sends can be sponsored.";
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
    expect(relayUseOf(config) !== "none").toBe(
      mode === SEND_MODE.PRIVATE_RELAY
    );
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
  // An old flag reads by its chain, so the editor's chain list is known here.
  beforeEach(() =>
    setEditorSendModeChains([
      { chainId: 1, name: "Ethereum", ...RELAY_CHAIN },
      { chainId: 8453, name: "Base", ...PLAIN_CHAIN },
    ])
  );
  afterEach(() => setEditorSendModeChains(undefined));

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

  it("Reset writes only Sponsor gas, whatever Send as is", () => {
    const relay = {
      ...write,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: "yes",
    };
    const change = switchSponsorGas(relay, undefined);
    expect(change.writes).toEqual([["sponsorGas", undefined]]);
    expect(change.notice).toBeUndefined();
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
    const unnamed = chooseNetwork(
      { ...write, network: "1", sendMode: "private-relay" },
      { chainId: 8453, ...PLAIN_CHAIN },
      "network"
    );
    expect(unnamed.notice).toBe(
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
    const chosen = {
      ...write,
      sendMode: "private-relay",
      usePrivateMempool: true,
    };
    expect(chooseNetwork(chosen, base, "network").writes).toContainEqual([
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

  it("shows the badge on a stored conflict that runs privately", () => {
    const conflict = {
      ...write,
      sendMode: "private-relay",
      usePrivateMempool: false,
    };
    expect(sendsPrivately(conflict)).toBe(true);
    expect(sendsPrivately({ ...conflict, network: "8453" })).toBe(false);
    expect(
      sendsPrivately({
        ...write,
        sendMode: "transaction",
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
type Shape = [string, Record<string, unknown>, SendMode, RelayUse];
type RelayUse = ReturnType<typeof relayUseOf>;
const SHAPES: Shape[] = [
  // [name, keys, mode once the chain is known, run-time relay use]
  ["true", { usePrivateMempool: true }, "private-relay", "if-available"],
  ['"false"', { usePrivateMempool: "false" }, "private-relay", "if-available"],
  ["1", { usePrivateMempool: 1 }, "private-relay", "if-available"],
  ['"yes"', { usePrivateMempool: "yes" }, "private-relay", "if-available"],
  ['"true"', { usePrivateMempool: "true" }, "private-relay", "if-available"],
  ["0", { usePrivateMempool: 0 }, "transaction", "none"],
  ['""', { usePrivateMempool: "" }, "transaction", "none"],
  ["null", { usePrivateMempool: null }, "transaction", "none"],
  ["false", { usePrivateMempool: false }, "transaction", "none"],
  [
    "sendMode relay",
    { sendMode: "private-relay" },
    "private-relay",
    "required",
  ],
  [
    "sendMode null + true",
    { sendMode: null, usePrivateMempool: true },
    "private-relay",
    "if-available",
  ],
];

describe("old flag values across chains", () => {
  afterEach(() => setEditorSendModeChains(undefined));

  it.each(SHAPES)(
    "%s reads by the chain, the same everywhere",
    (_name, keys, mode, relay) => {
      expect(relayUseOf(keys)).toBe(relay);

      // The editor reads it as the run does once the chain list is known.
      setEditorSendModeChains([ETHEREUM, BASE]);
      for (const network of ["1", "8453"]) {
        const config = { actionType: "web3/write-contract", network, ...keys };
        expect(editorSendMode(config)).toBe(mode);
        const isPrivate = mode !== "transaction";
        // PRIVATE only where the relay is used; Base has none.
        expect(sendsPrivately(config)).toBe(isPrivate && network === "1");
        // Never sponsored while the step asks for the relay, as at run time.
        expect(shownSponsorGas(config)).toBe(isPrivate ? false : undefined);
        expect(wouldBeSponsored(config, "network")).toBe(!isPrivate);
        // Fails before sending only for an explicit relay on Base.
        expect(sendModeWarning(config)?.fails === true).toBe(
          relay === "required" && network === "8453"
        );
        // Batch resets a relay node to Normal and keeps a Normal one.
        const batch = buildConfigForActionTypeChange(
          "web3/batch-write-contract",
          config
        );
        expect(resolveSendMode(batch)).toBe("transaction");
      }
    }
  );

  it("keeps an old flag as saved when it moves network: it uses a relay where there is one", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const onBase = {
      actionType: "web3/write-contract",
      network: "8453",
      usePrivateMempool: "false",
    };
    for (const change of [
      chooseNetwork(onBase, ETHEREUM, "network"),
      chooseNetwork({ ...onBase, network: "1" }, BASE, "network"),
      chooseNetwork({ ...onBase, usePrivateMempool: true }, BASE, "network"),
    ]) {
      expect(change.writes).toEqual([]);
      expect(change.notice).toBeUndefined();
    }
    // An explicit Private relay moved to Base goes Normal, with a notice.
    const toBase = chooseNetwork(
      { ...onBase, network: "1", sendMode: "private-relay" },
      BASE,
      "network"
    );
    expect(toBase.writes.slice(0, 2)).toEqual([
      ["sendMode", "transaction"],
      ["usePrivateMempool", false],
    ]);
    expect(toBase.notice).toContain("Base has no private relay");
  });

  it("says an old flag on a chain without a relay sends publicly, with no marker", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    for (const actionType of [
      "web3/write-contract",
      "web3/batch-write-contract",
    ]) {
      const warning = sendModeWarning({
        actionType,
        network: "8453",
        usePrivateMempool: true,
      });
      expect(warning).toEqual({
        text: "Base has no private relay, so this step sends to the public mempool.",
        unsupported: false,
        fails: false,
      });
    }
  });
});

describe("Send as keys to fix", () => {
  afterEach(() => setEditorSendModeChains(undefined));

  it("says a key conflict runs as sendMode, saves keep it, and names the fix; no canvas marker", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const base = { actionType: "web3/write-contract", network: "1" };
    expect(
      sendModeWarning({
        ...base,
        sendMode: "transaction",
        usePrivateMempool: true,
      })
    ).toEqual({
      text: "This step's saved Send as settings disagree. It runs as Normal transaction; saving keeps them as they are, but a new network or action needs the fix first. Pick Use Normal transaction to fix it.",
      unsupported: false,
      fails: false,
      keys: true,
    });
    expect(
      sendModeWarning({
        ...base,
        sendMode: "private-relay",
        usePrivateMempool: false,
      })
    ).toEqual({
      text: "This step's saved Send as settings disagree. It runs as Private relay; saving keeps them as they are, but a new network or action needs the fix first. Pick Use Normal transaction or Keep Private relay to fix it.",
      unsupported: false,
      fails: false,
      keys: true,
    });
  });

  it("checks a Private relay conflict as it runs: it fails without a relay or on Batch", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const conflict = { sendMode: "private-relay", usePrivateMempool: false };
    const noRelay = {
      actionType: "web3/write-contract",
      network: "8453",
      ...conflict,
    };
    expect(sendModeWarning(noRelay)).toEqual({
      text: "This step's saved Send as settings disagree. Base has no private relay, so this step fails before sending. Pick Use Normal transaction to fix it.",
      unsupported: false,
      fails: true,
      keys: true,
    });
    expect(sendsPrivately(noRelay)).toBe(false);

    const batch = sendModeWarning({
      actionType: "web3/batch-write-contract",
      network: "1",
      ...conflict,
    });
    expect(batch).toMatchObject({ unsupported: true, fails: true, keys: true });
    expect(batch?.text).toMatch(
      /^This step's saved Send as settings disagree\. Batch Write Contract can't send through the private relay yet/
    );

    // A step that falls back sends publicly: no marker, and it says so.
    expect(sendModeWarning({ ...noRelay, strict: false })).toMatchObject({
      text: "This step's saved Send as settings disagree. Base has no private relay, so this step sends to the public mempool. Pick Use Normal transaction to fix it.",
      fails: false,
      keys: true,
    });
  });

  it("says an unknown mode fails and names the button that fixes it", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const base = { actionType: "web3/write-contract", network: "1" };
    expect(sendModeWarning({ ...base, sendMode: "Private-Relay" })).toEqual({
      text: "This step's saved Send as value is not a known choice, so the step fails before sending. Pick Use Normal transaction to fix it.",
      unsupported: false,
      fails: true,
      keys: true,
    });
    expect(
      sendModeWarning({
        ...base,
        sendMode: "Private-Relay",
        usePrivateMempool: true,
      })?.text
    ).toContain("Pick Use Normal transaction or Keep Private relay to fix it.");
  });
});

describe("before the chain list is known", () => {
  afterEach(() => setEditorSendModeChains(undefined));

  it("keeps an old flag neutral: no badge, Sponsor gas as stored", () => {
    setEditorSendModeChains(undefined);
    for (const flag of ["false", 1, "yes", "true", true]) {
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
    // A chosen Private relay still shows as one.
    const chosen = {
      actionType: "web3/write-contract",
      network: "1",
      sendMode: "private-relay",
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
    expect(editorSendMode({ ...old, network: "base" })).toBe("private-relay");
    expect(sendModeWarning({ ...old, network: "base" })?.text).toBe(
      "Base has no private relay, so this step sends to the public mempool."
    );
    expect(editorSendMode({ ...old, network: "mainnet" })).toBe(
      "private-relay"
    );
    expect(sendsPrivately({ ...old, network: "base" })).toBe(false);
    expect(sendsPrivately({ ...old, network: "mainnet" })).toBe(true);
    // A template network: the relay where the chain has one, with a neutral notice.
    const templated = { ...old, network: "{{@x:X.chain}}" };
    expect(editorSendMode(templated)).toBe("private-relay");
    expect(sendModeWarning(templated)).toEqual({
      text: "This step uses the private relay where its network has one, otherwise the public mempool.",
      unsupported: false,
      fails: false,
    });
    expect(sendsPrivately(templated)).toBe(false);
    expect(shownSponsorGas(templated)).toBe(false);
    // Normal only while the chain list loads.
    setEditorSendModeChains(undefined);
    expect(editorSendMode(templated)).toBe("transaction");
    expect(sendModeWarning(templated)).toBeUndefined();
  });
});

describe("canvas marker for a step Send as stops", () => {
  afterEach(() => setEditorSendModeChains(undefined));

  const BATCH = "web3/batch-write-contract";
  const WRITE = "web3/write-contract";
  // [name, config, fails before sending, PRIVATE badge]
  const NODES: [string, Record<string, unknown>, boolean, boolean][] = [
    [
      "true on Base (sends publicly)",
      { actionType: WRITE, network: "8453", usePrivateMempool: true },
      false,
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
      "Batch true on Base (sends publicly)",
      { actionType: BATCH, network: "8453", usePrivateMempool: true },
      false,
      false,
    ],
    [
      "Batch old flag on Ethereum",
      { actionType: BATCH, network: "1", usePrivateMempool: "false" },
      true,
      false,
    ],
    [
      "Batch old flag on Ethereum, strict default (its check is refused on the relay)",
      { actionType: BATCH, network: "1", usePrivateMempool: true },
      true,
      false,
    ],
    [
      "Batch old flag on Ethereum, strict: false at Latest (check on the regular RPC, sent privately)",
      {
        actionType: BATCH,
        network: "1",
        usePrivateMempool: true,
        strict: false,
      },
      false,
      true,
    ],
    [
      "Batch old flag on Ethereum, strict: false, Simulate at Next block",
      {
        actionType: BATCH,
        network: "1",
        usePrivateMempool: true,
        strict: false,
        simulateAt: "next-block",
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
      "old flag on Base (sends publicly)",
      { actionType: WRITE, network: "8453", usePrivateMempool: "false" },
      false,
      false,
    ],
    [
      "Batch old flag on Base (sends publicly)",
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
    [
      "unknown sendMode (refused at run time)",
      { actionType: WRITE, network: "1", sendMode: "Private-Relay" },
      true,
      false,
    ],
    [
      "keys in conflict (refused at save)",
      {
        actionType: WRITE,
        network: "8453",
        sendMode: "transaction",
        usePrivateMempool: true,
      },
      false,
      false,
    ],
  ];

  it.each(NODES)("%s", (_name, config, fails, badge) => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    expect(sendModeWarning(config)?.fails === true).toBe(fails);
    expect(sendsPrivately(config)).toBe(badge);
    // Never both a warning marker and the PRIVATE badge.
    expect(fails && badge).toBe(false);
  });

  it("says when an old Batch flag fails and when strict: false lets it run", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const old = { actionType: BATCH, network: "1", usePrivateMempool: true };
    const saved =
      'This step was saved with the old "(Flashbots)" network, so it still sends through Ethereum\'s private relay.';
    const fix =
      "Set Send as to Normal transaction to send publicly, or split the calls into Write Contract steps to keep them private.";
    expect(sendModeWarning(old)).toEqual({
      text: `${saved} Batch Write Contract checks its calls with eth_call first, which the private relay refuses, so every run fails before sending. ${fix}`,
      unsupported: true,
      fails: true,
    });
    expect(
      sendModeWarning({ ...old, strict: false, simulateAt: "next-block" })
    ).toEqual({
      text: `${saved} Batch Write Contract checks its calls as of the next block first, which the private relay refuses, and strict: false does not move that check elsewhere, so every run fails before sending. ${fix}`,
      unsupported: true,
      fails: true,
    });
    expect(sendModeWarning({ ...old, strict: false })).toEqual({
      text: `${saved} The relay refuses Batch Write Contract's eth_call check, so with strict: false that check runs on Ethereum's regular RPC (your calls are public there), and the transaction still goes through the private relay.`,
      unsupported: true,
      fails: false,
      sendsPrivately: true,
    });
    // Only boolean false lifts it, as the run reads it.
    expect(sendModeWarning({ ...old, strict: "false" })?.fails).toBe(true);
    // A templated network: a note, no marker, no PRIVATE badge (it may have no relay).
    const templated = { ...old, strict: false, network: "{{@x:X.chain}}" };
    expect(sendModeWarning(templated)).toMatchObject({ fails: false });
    expect(sendModeWarning(templated)?.text).toContain(
      "strict: false runs that check on the network's regular RPC"
    );
    expect(sendsPrivately(templated)).toBe(false);
  });
});

describe("unknown sendMode values", () => {
  it.each([
    "Private-Relay",
    "PRIVATE-RELAY",
    "private_relay",
    " private-relay",
    "private-relay ",
    "Bundle",
    "{{@x:X.mode}}",
    true,
    1,
  ])("refuses %j", (value) => {
    expect(unknownSendModeIssue(value)).toBe(
      `sendMode must be "transaction" (Normal transaction) or "private-relay" (Private relay), not ${JSON.stringify(value)}.`
    );
  });

  it.each([undefined, null, "", "transaction", "private-relay", "bundle"])(
    "lets %j through",
    (value) => {
      expect(unknownSendModeIssue(value)).toBeUndefined();
    }
  );
});

describe("editor repairs and edge values", () => {
  afterEach(() => setEditorSendModeChains(undefined));
  const write = { actionType: "web3/write-contract", network: "8453" };

  it("lets Normal repair keys a save refuses, even when they already read as Normal", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const unknown = { ...write, sendMode: "bogus" };
    const conflict = {
      ...write,
      sendMode: "transaction",
      usePrivateMempool: true,
    };
    for (const config of [unknown, conflict]) {
      expect(editorSendMode(config)).toBe("transaction");
      expect(pickChanges(config, "transaction")).toBe(true);
      expect(pickSendMode(config, "transaction").writes.slice(0, 2)).toEqual([
        ["sendMode", "transaction"],
        ["usePrivateMempool", false],
      ]);
      expect(sendModeWarning(config)?.text).toBeDefined();
    }
    const agreed = {
      ...write,
      sendMode: "transaction",
      usePrivateMempool: false,
    };
    expect(pickChanges(agreed, "transaction")).toBe(false);
  });

  it("shows a Sponsor gas value that is neither on nor off as stored, so it can be reset", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const relay = { ...write, network: "1", sendMode: "private-relay" };
    expect(shownSponsorGas({ ...relay, sponsorGas: "yes" })).toBe("yes");
    expect(shownSponsorGas({ ...relay, sponsorGas: true })).toBe(false);
    expect(shownSponsorGas({ ...relay })).toBe(false);
  });

  it("records Undo values the editor can write back (no null or numbers)", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const eth = { ...write, network: "1" };
    const nulls = pickSendMode(
      { ...eth, usePrivateMempool: null, sponsorGas: null },
      "private-relay"
    );
    expect(nulls.undo).toEqual([
      ["sendMode", undefined],
      ["usePrivateMempool", undefined],
      ["sponsorGas", undefined],
    ]);
    const numbers = pickSendMode(
      { ...eth, usePrivateMempool: 0, sponsorGas: 1 },
      "private-relay"
    );
    expect(numbers.undo).toEqual([
      ["sendMode", undefined],
      ["usePrivateMempool", false],
      ["sponsorGas", undefined],
    ]);
  });

  it("tells the user when an action switch set Send as back to Normal", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const before = {
      actionType: "web3/write-contract",
      network: "1",
      sendMode: "private-relay",
      usePrivateMempool: true,
    };
    // As the editor applies it: the new action type, then the transition.
    const switchTo = (
      config: Record<string, unknown>
    ): Record<string, unknown> =>
      buildConfigForActionTypeChange("web3/batch-write-contract", {
        ...config,
        actionType: "web3/batch-write-contract",
      });
    const change = actionSwitchNotice(before, switchTo(before));
    expect(change?.notice).toBe(
      "Send as changed to Normal transaction (public mempool): Batch Write Contract can't send through the private relay yet."
    );
    expect(change?.undo).toEqual([]);
    // Every value of the new step's form, so an edit there drops the notice.
    const after = switchTo({ ...before, integrationId: "int-1" });
    const wrote = actionSwitchNotice(before, after)?.wrote ?? [];
    expect(wrote).toContainEqual(["actionType", "web3/batch-write-contract"]);
    expect(wrote).toContainEqual(["sendMode", "transaction"]);
    expect(wrote).toContainEqual(["usePrivateMempool", false]);
    expect(wrote).toContainEqual(["isolateCallFailures", "true"]);
    expect(wrote.some(([key]) => key === "integrationId")).toBe(false);
    // A Normal step switching has nothing to tell.
    const normal = {
      ...before,
      sendMode: "transaction",
      usePrivateMempool: false,
    };
    expect(actionSwitchNotice(normal, switchTo(normal))).toBeUndefined();
  });

  it("keeps the switch notice through form fills, not through user edits", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const before = {
      actionType: "web3/write-contract",
      network: "1",
      sendMode: "private-relay",
      usePrivateMempool: true,
    };
    const after = buildConfigForActionTypeChange("web3/batch-write-contract", {
      ...before,
      actionType: "web3/batch-write-contract",
    });
    const wrote = actionSwitchNotice(before, after)?.wrote ?? [];
    expect(wrote).toContainEqual(["calls", undefined]);
    const holds = (edit: Record<string, unknown>): boolean =>
      untouchedSinceSwitch({ ...after, ...edit }, wrote);
    const row = {
      network: "",
      contractAddress: "",
      abi: "",
      abiFunction: "",
      args: [],
      useManualAbi: "false",
    };
    // The Calls editor's first empty row, an empty list, or a blank key.
    expect(holds({})).toBe(true);
    expect(holds({ calls: JSON.stringify([row]) })).toBe(true);
    expect(holds({ calls: "[]" })).toBe(true);
    expect(holds({ calls: "" })).toBe(true);
    // Anything the user typed or picked drops it.
    expect(
      holds({ calls: JSON.stringify([{ ...row, contractAddress: "0x1" }]) })
    ).toBe(false);
    expect(
      holds({ calls: JSON.stringify([{ ...row, useManualAbi: "true" }]) })
    ).toBe(false);
    expect(holds({ calls: "0x1" })).toBe(false);
    expect(holds({ isolateCallFailures: "false" })).toBe(false);
    // Send as, the action and the network must hold exactly.
    expect(holds({ sendMode: undefined })).toBe(false);
    expect(holds({ usePrivateMempool: undefined })).toBe(false);
    expect(holds({ network: "8453" })).toBe(false);
    expect(holds({ actionType: "web3/write-contract" })).toBe(false);
    // A key the switch left unset may take the field's own default, only that.
    const unset = wrote.map(([key, value]): [string, unknown] =>
      key === "isolateCallFailures" ? [key, undefined] : [key, value]
    );
    expect(
      untouchedSinceSwitch({ ...after, isolateCallFailures: "true" }, unset)
    ).toBe(true);
    expect(
      untouchedSinceSwitch({ ...after, isolateCallFailures: "false" }, unset)
    ).toBe(false);
  });

  it("says an old flag on a network without a relay already sent publicly", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const before = {
      actionType: "web3/write-contract",
      network: "8453",
      usePrivateMempool: true,
    };
    const after = buildConfigForActionTypeChange("web3/batch-write-contract", {
      ...before,
      actionType: "web3/batch-write-contract",
    });
    // Batch Write Contract has no Sponsor gas, so it stays unsponsored.
    expect(actionSwitchNotice(before, after)?.notice).toBe(
      "Send as changed to Normal transaction: Base has no private relay, so this step already sent to the public mempool."
    );
  });

  it("does not say how an old flag sent on a network not known (a template)", () => {
    setEditorSendModeChains([ETHEREUM, BASE]);
    const before = {
      actionType: "web3/write-contract",
      network: "{{@trigger:Webhook.chain}}",
      usePrivateMempool: true,
    };
    const after = buildConfigForActionTypeChange("web3/batch-write-contract", {
      ...before,
      actionType: "web3/batch-write-contract",
    });
    expect(actionSwitchNotice(before, after)?.notice).toBe(
      "Send as changed to Normal transaction: this step now sends to the public mempool on every network (Batch Write Contract has no private relay option yet)."
    );
    // The old flag left on Batch there may fail, depending on the network.
    expect(
      sendModeWarning({ ...before, actionType: "web3/batch-write-contract" })
        ?.text
    ).toContain(
      "still sends through the private relay where its network has one, otherwise the public mempool"
    );
  });

  it("drops the old flag with Send as when the new action has no Send as", () => {
    const relay = {
      actionType: "web3/write-contract",
      network: "1",
      sendMode: "private-relay",
      usePrivateMempool: true,
      strict: false,
    };
    const read = buildConfigForActionTypeChange("web3/read-contract", relay);
    expect(read.sendMode).toBeUndefined();
    expect(read.usePrivateMempool).toBeUndefined();
    expect(read.strict).toBeUndefined();
    const back = buildConfigForActionTypeChange("web3/write-contract", read);
    expect(back.usePrivateMempool).toBeUndefined();
    expect(back.sendMode).toBeUndefined();
    expect(back.strict).toBeUndefined();
    // Kept on a switch between two actions with Send as.
    const batch = buildConfigForActionTypeChange(
      "web3/batch-write-contract",
      relay
    );
    expect(batch.strict).toBe(false);
  });
});
