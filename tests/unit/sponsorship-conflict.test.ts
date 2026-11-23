import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sponsorshipConflictFor } from "@/lib/workflow/editor/sponsorship-conflict";
import type { ActionConfigFieldBase } from "@/plugins/registry";

const FEE_FIELD: ActionConfigFieldBase = {
  key: "priorityFeeGwei",
  label: "Priority Fee (gwei)",
  type: "template-input",
  sponsorshipConflict: "skips-sponsorship",
};

const GAS_LIMIT_FIELD: ActionConfigFieldBase = {
  key: "gasLimitMultiplier",
  label: "Gas Limit",
  type: "gas-limit-multiplier",
  sponsorshipConflict: "not-applied-when-sponsored",
};

const GAS_LIMIT = JSON.stringify({ mode: "maxGasLimit", value: "350000" });
// Ethereum mainnet is covered by sponsorship; Optimism is not.
const SPONSORED_NETWORK = "1";
const UNSPONSORED_NETWORK = "10";

describe("sponsorshipConflictFor", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns for a set fee while Sponsor gas is on by default", () => {
    expect(
      sponsorshipConflictFor(FEE_FIELD, {
        network: SPONSORED_NETWORK,
        priorityFeeGwei: "3",
      })
    ).toBe("skips-sponsorship");
  });

  it("warns for a set gas limit while sponsored", () => {
    expect(
      sponsorshipConflictFor(GAS_LIMIT_FIELD, {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: GAS_LIMIT,
        sponsorGas: true,
      })
    ).toBe("not-applied-when-sponsored");
  });

  it.each([
    [
      "the field is empty",
      { network: SPONSORED_NETWORK, priorityFeeGwei: " " },
    ],
    [
      "Sponsor gas is off",
      { network: SPONSORED_NETWORK, priorityFeeGwei: "3", sponsorGas: false },
    ],
    [
      'Sponsor gas is stored as "false"',
      { network: SPONSORED_NETWORK, priorityFeeGwei: "3", sponsorGas: "false" },
    ],
    [
      "the network is not sponsored",
      { network: UNSPONSORED_NETWORK, priorityFeeGwei: "3" },
    ],
    [
      "the node uses a private mempool",
      {
        network: SPONSORED_NETWORK,
        priorityFeeGwei: "3",
        usePrivateMempool: true,
      },
    ],
  ])("stays quiet when %s", (_label, config) => {
    expect(sponsorshipConflictFor(FEE_FIELD, config)).toBeUndefined();
  });

  it("stays quiet when sponsorship is disabled for the deployment", () => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "false");
    expect(
      sponsorshipConflictFor(FEE_FIELD, {
        network: SPONSORED_NETWORK,
        priorityFeeGwei: "3",
      })
    ).toBeUndefined();
  });

  it("stays quiet for a cleared gas limit", () => {
    expect(
      sponsorshipConflictFor(GAS_LIMIT_FIELD, {
        network: SPONSORED_NETWORK,
        gasLimitMultiplier: "",
      })
    ).toBeUndefined();
  });

  it("stays quiet for a field without the flag", () => {
    expect(
      sponsorshipConflictFor(
        { ...FEE_FIELD, sponsorshipConflict: undefined },
        { network: SPONSORED_NETWORK, priorityFeeGwei: "3" }
      )
    ).toBeUndefined();
  });
});
