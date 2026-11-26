import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isIgnoredWhileSponsored } from "@/lib/workflow/editor/sponsorship-conflict";
import type { ActionConfigFieldBase } from "@/plugins/registry";

const GAS_LIMIT_FIELD: ActionConfigFieldBase = {
  key: "gasLimitMultiplier",
  label: "Gas Limit",
  type: "gas-limit-multiplier",
  ignoredWhenSponsored: true,
};

const GAS_LIMIT = JSON.stringify({ mode: "maxGasLimit", value: "350000" });
// Ethereum mainnet is covered by sponsorship; Optimism is not.
const SPONSORED_NETWORK = "1";
const UNSPONSORED_NETWORK = "10";

describe("isIgnoredWhileSponsored", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns for a set gas limit while Sponsor gas is on by default", () => {
    expect(
      isIgnoredWhileSponsored(GAS_LIMIT_FIELD, {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
      })
    ).toBe(true);
  });

  it.each([
    [
      "the gas limit is cleared",
      { network: SPONSORED_NETWORK, gasLimitMultiplier: "" },
    ],
    [
      "Sponsor gas is off",
      {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
        sponsorGas: false,
      },
    ],
    [
      'Sponsor gas is stored as "false"',
      {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
        sponsorGas: "false",
      },
    ],
    [
      "the network is not sponsored",
      { network: UNSPONSORED_NETWORK, gasLimitMultiplier: GAS_LIMIT },
    ],
    [
      "the node uses a private mempool",
      {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
        sendMode: "private-relay",
      },
    ],
    [
      "the node sends through an explicit Safe",
      {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
        web3Connection: "safe:abc",
      },
    ],
    [
      "a custom fee already sends the node unsponsored",
      {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
        maxFeeGwei: "50",
      },
    ],
  ])("stays quiet when %s", (_label, config) => {
    expect(isIgnoredWhileSponsored(GAS_LIMIT_FIELD, config)).toBe(false);
  });

  it("stays quiet when sponsorship is disabled for the deployment", () => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "false");
    expect(
      isIgnoredWhileSponsored(GAS_LIMIT_FIELD, {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
      })
    ).toBe(false);
  });

  it("stays quiet for a field without the flag", () => {
    expect(
      isIgnoredWhileSponsored(
        { ...GAS_LIMIT_FIELD, ignoredWhenSponsored: undefined },
        { network: SPONSORED_NETWORK, gasLimitMultiplier: GAS_LIMIT }
      )
    ).toBe(false);
  });
});
