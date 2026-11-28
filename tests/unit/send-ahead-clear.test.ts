import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  chooseNetwork,
  pickSendMode,
  switchSponsorGas,
} from "@/lib/workflow/editor/send-mode-editor";

// Not before and Send ahead only apply to the bundle modes: leaving them clears both.
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
        "Not before and Send ahead were cleared: they only apply to Send as Bundle or Bundle and public."
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
      "Not before was cleared: it only applies to Send as Bundle or Bundle and public."
    );
    const onlyAhead = { ...bundle, notBefore: "" };
    expect(pickSendMode(onlyAhead, "private-relay").notice).toBe(
      "Send ahead was cleared: it only applies to Send as Bundle or Bundle and public."
    );
  });

  it("clears them when Sponsor gas or a network without builders sets Normal, and says so", () => {
    const sponsor = switchSponsorGas(bundle, true);
    expect(sponsor.writes).toEqual(
      expect.arrayContaining([["notBefore", undefined]])
    );
    expect(sponsor.notice).toBe(
      "Send as changed to Normal transaction (public mempool): only normal sends can be sponsored. Not before and Send ahead were cleared: they only apply to Send as Bundle or Bundle and public."
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
      "Send as changed to Normal transaction (public mempool): Base has no block builders that take bundles. Not before and Send ahead were cleared: they only apply to Send as Bundle or Bundle and public."
    );
    // Nothing set: the notices stay as before.
    const plain = { ...bundle, notBefore: "", sendAheadBlocks: undefined };
    expect(chooseNetwork(plain, base, "network").notice).toBe(
      "Send as changed to Normal transaction (public mempool): Base has no block builders that take bundles."
    );
  });
});

// If not included only applies to Bundle: Bundle and public keeps it hidden; other modes clear it.
describe("Send as and If not included", () => {
  const bundle = {
    actionType: "web3/write-contract",
    network: "1",
    sendMode: "bundle",
    usePrivateMempool: false,
    sponsorGas: false,
    bundleBlocks: "4",
    bundleBuilders: ["flashbots"],
    bundleTipIncreasePercent: "10",
    bundleFallback: "public",
  };
  const keys = (writes: [string, unknown][]) => writes.map(([key]) => key);
  const ONLY =
    "If not included was cleared: it only applies to Send as Bundle.";

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

  it("keeps every bundle setting between Bundle and Bundle and public", () => {
    const toPublic = pickSendMode(bundle, "bundle-and-public");
    expect(Object.fromEntries(toPublic.writes)).toEqual({
      sendMode: "bundle-and-public",
      usePrivateMempool: false,
    });
    expect(toPublic.notice).toBeUndefined();
    const back = pickSendMode(
      { ...bundle, sendMode: "bundle-and-public", notBefore: "1796126400" },
      "bundle"
    );
    expect(Object.fromEntries(back.writes)).toEqual({
      sendMode: "bundle",
      usePrivateMempool: false,
    });
    expect(back.notice).toBeUndefined();
  });

  it.each(["transaction", "private-relay"] as const)(
    "clears it on %s, names it, and Undo puts it back",
    (mode) => {
      const change = pickSendMode(bundle, mode);
      expect(change.writes).toContainEqual(["bundleFallback", undefined]);
      expect(change.undo).toContainEqual(["bundleFallback", "public"]);
      // The other bundle settings are hidden there and ignored; a save keeps them.
      expect(keys(change.writes)).not.toContain("bundleBlocks");
      expect(change.notice).toBe(ONLY);
    }
  );

  it("clears a value Bundle and public kept hidden, Stop included", () => {
    const change = pickSendMode(
      { ...bundle, sendMode: "bundle-and-public", bundleFallback: "stop" },
      "transaction"
    );
    expect(change.writes).toContainEqual(["bundleFallback", undefined]);
    expect(change.notice).toBe(ONLY);
  });

  it("names every key it cleared, in one line", () => {
    const all = {
      ...bundle,
      notBefore: "1796126400",
      sendAheadBlocks: "1",
    };
    expect(pickSendMode(all, "transaction").notice).toBe(
      "Not before and Send ahead were cleared: they only apply to Send as Bundle or Bundle and public. If not included was cleared: it only applies to Send as Bundle."
    );
    const two = { ...bundle, sendAheadBlocks: "1" };
    expect(pickSendMode(two, "private-relay").notice).toBe(
      "Send ahead was cleared: it only applies to Send as Bundle or Bundle and public. If not included was cleared: it only applies to Send as Bundle."
    );
  });

  it("writes nothing for it when unset", () => {
    const plain = { ...bundle, bundleFallback: "" };
    const change = pickSendMode(plain, "transaction");
    expect(keys(change.writes)).not.toContain("bundleFallback");
    expect(change.notice).toBeUndefined();
  });

  it("clears it when Sponsor gas or a network without builders sets Normal", () => {
    const sponsor = switchSponsorGas(bundle, true);
    expect(sponsor.writes).toContainEqual(["bundleFallback", undefined]);
    expect(sponsor.undo).toContainEqual(["bundleFallback", "public"]);
    expect(sponsor.notice).toBe(
      `Send as changed to Normal transaction (public mempool): only normal sends can be sponsored. ${ONLY}`
    );
    const base = { chainId: 8453, name: "Base", usePrivateMempoolRpc: false };
    const network = chooseNetwork(bundle, base, "network");
    expect(network.writes).toContainEqual(["bundleFallback", undefined]);
    expect(network.notice).toBe(
      `Send as changed to Normal transaction (public mempool): Base has no block builders that take bundles. ${ONLY}`
    );
  });
});
