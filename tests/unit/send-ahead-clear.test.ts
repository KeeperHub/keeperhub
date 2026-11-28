import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  chooseNetwork,
  pickSendMode,
  switchSponsorGas,
} from "@/lib/workflow/editor/send-mode-editor";

// Not before and Send ahead only apply to Send as Bundle: leaving Bundle clears them.
describe("Send as away from Bundle clears Not before and Send ahead", () => {
  const bundle = {
    actionType: "web3/write-contract",
    network: "1",
    sendMode: "bundle",
    usePrivateMempool: false,
    sponsorGas: false,
    notBefore: "{{Read Contract.result}}",
    sendAheadBlocks: "2",
  };

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
    setEditorSendModeChains([
      {
        chainId: 1,
        name: "Ethereum",
        usePrivateMempoolRpc: true,
        bundleBuilders: ["flashbots"],
        bundlesEnabled: true,
      },
      { chainId: 8453, name: "Base", usePrivateMempoolRpc: false },
    ]);
  });
  afterEach(() => {
    setEditorSendModeChains(undefined);
    vi.unstubAllEnvs();
  });

  it.each(["transaction", "private-relay"] as const)(
    "clears both on %s, with an Undo that puts them back",
    (mode) => {
      const change = pickSendMode(bundle, mode);
      expect(change.writes).toEqual(
        expect.arrayContaining([
          ["notBefore", undefined],
          ["sendAheadBlocks", undefined],
        ])
      );
      expect(change.undo).toEqual(
        expect.arrayContaining([
          ["notBefore", "{{Read Contract.result}}"],
          ["sendAheadBlocks", "2"],
        ])
      );
      expect(change.notice).toBe(
        "Not before and Send ahead were cleared: they only apply to Send as Bundle."
      );
    }
  );

  it("keeps them when Bundle is picked again, and writes nothing when unset", () => {
    const keys = (writes: [string, unknown][]) => writes.map(([key]) => key);
    expect(keys(pickSendMode(bundle, "bundle").writes)).not.toContain(
      "notBefore"
    );
    const plain = { ...bundle, notBefore: "", sendAheadBlocks: undefined };
    const change = pickSendMode(plain, "transaction");
    expect(keys(change.writes)).not.toContain("notBefore");
    expect(keys(change.writes)).not.toContain("sendAheadBlocks");
    expect(change.notice).toBeUndefined();
  });

  it("names only the keys it cleared", () => {
    const onlyNotBefore = { ...bundle, sendAheadBlocks: undefined };
    expect(pickSendMode(onlyNotBefore, "transaction").notice).toBe(
      "Not before was cleared: it only applies to Send as Bundle."
    );
    const onlyAhead = { ...bundle, notBefore: "" };
    expect(pickSendMode(onlyAhead, "private-relay").notice).toBe(
      "Send ahead was cleared: it only applies to Send as Bundle."
    );
  });

  it("clears them when Sponsor gas or a network without builders sets Normal, and says so", () => {
    const sponsor = switchSponsorGas(bundle, true);
    expect(sponsor.writes).toEqual(
      expect.arrayContaining([["notBefore", undefined]])
    );
    expect(sponsor.notice).toBe(
      "Send as changed to Normal transaction (public mempool): only normal sends can be sponsored. Not before and Send ahead were cleared: they only apply to Send as Bundle."
    );
    const base = { chainId: 8453, name: "Base", usePrivateMempoolRpc: false };
    const network = chooseNetwork(bundle, base, "network");
    expect(network.writes).toEqual(
      expect.arrayContaining([
        ["notBefore", undefined],
        ["sendAheadBlocks", undefined],
      ])
    );
    expect(network.notice).toBe(
      "Send as changed to Normal transaction (public mempool): Base has no block builders that take bundles. Not before and Send ahead were cleared: they only apply to Send as Bundle."
    );
    // Nothing set: the notices stay as before.
    const plain = { ...bundle, notBefore: "", sendAheadBlocks: undefined };
    expect(chooseNetwork(plain, base, "network").notice).toBe(
      "Send as changed to Normal transaction (public mempool): Base has no block builders that take bundles."
    );
  });
});
