import { describe, expect, it } from "vitest";
import {
  BASE_CHAIN_ID,
  TEMPO_MAINNET_CHAIN_ID,
  USDC_BASE_ADDRESS,
  USDC_TEMPO_ADDRESS,
} from "@/lib/agentic-wallet/constants";
import { BASE_USDC_DOMAIN } from "@/lib/agentic-wallet/sign";
import {
  BASE_RAIL,
  PAYMENT_RAILS,
  pickSingleRail,
  railForProtocol,
  railsFor,
  TEMPO_RAIL,
  toAssetUnits,
} from "@/lib/payments/rails";
import { buildPaymentConfig } from "@/lib/payments/x402/payment-gate";

const workflow = {
  priceUsdcPerCall: "1.00",
  listedSlug: "my-workflow",
  name: "My Workflow",
};

const PAYEE = "0x1234000000000000000000000000000000005678";

describe("payment rail table", () => {
  it("states a network id consistent with its chain id", () => {
    // A rail whose CAIP-2 string disagreed with its numeric chain id would
    // advertise one chain and sign for another, and nothing else in the stack
    // compares the two.
    for (const rail of Object.values(PAYMENT_RAILS)) {
      expect(rail.network).toBe(`eip155:${rail.chainId}`);
    }
  });

  it("keys every rail by its own network id", () => {
    for (const [key, rail] of Object.entries(PAYMENT_RAILS)) {
      expect(key).toBe(rail.network);
    }
  });

  it("keeps the two protocols on separate rails", () => {
    expect(railsFor("x402")).toEqual([BASE_RAIL]);
    expect(railsFor("mpp")).toEqual([TEMPO_RAIL]);
  });

  it("refuses to guess when a protocol has more than one rail", () => {
    // The failure this prevents is silent: picking whichever rail happened to
    // be declared first would advertise a settlement asset nobody chose.
    const twoX402 = [
      BASE_RAIL,
      { ...TEMPO_RAIL, protocols: ["x402"] as const },
    ];
    expect(() => pickSingleRail(twoX402, "x402")).toThrow(
      "Expected exactly one x402 rail, found 2"
    );
  });

  it("refuses to guess when a protocol has no rail at all", () => {
    expect(() => pickSingleRail([BASE_RAIL], "mpp")).toThrow(
      "Expected exactly one mpp rail, found 0"
    );
  });

  it("resolves each live protocol to its one rail", () => {
    expect(railForProtocol("x402")).toBe(BASE_RAIL);
    expect(railForProtocol("mpp")).toBe(TEMPO_RAIL);
  });

  it("converts a price to the rail asset's smallest unit", () => {
    expect(toAssetUnits(BASE_RAIL, "1.00")).toBe(1_000_000);
    // Sub-cent listings must survive: rounding them to cents made the gate
    // demand an amount the 402 never advertised.
    expect(toAssetUnits(BASE_RAIL, "0.005")).toBe(5000);
  });
});

describe("rail identity is shared, not restated", () => {
  it("advertises the same EIP-712 domain the signer signs over", () => {
    // KEEP-364: these were two literals in two files kept in step by a
    // comment. When they drifted the CDP facilitator rejected every payment
    // with "EIP-712 domain parameters (name, version) are required". They are
    // now one value, so the drift is not expressible.
    const accepts = buildPaymentConfig(
      workflow as Parameters<typeof buildPaymentConfig>[0],
      PAYEE
    ).accepts as unknown as Record<string, unknown>;
    const extra = accepts.extra as Record<string, unknown>;

    expect(extra.name).toBe(BASE_USDC_DOMAIN.name);
    expect(extra.version).toBe(BASE_USDC_DOMAIN.version);
    expect(extra.name).toBe(BASE_RAIL.domain.name);
    expect(extra.version).toBe(BASE_RAIL.domain.version);
  });

  it("signs against the rail's own asset and chain", () => {
    expect(BASE_USDC_DOMAIN.chainId).toBe(BASE_RAIL.chainId);
    expect(BASE_USDC_DOMAIN.verifyingContract).toBe(BASE_RAIL.asset);
  });

  it("gives the agentic wallet the same addresses and chain ids as the rails", () => {
    // constants.ts described itself as the single source of truth while three
    // other files declared their own copies. It now derives from the rails.
    expect(USDC_BASE_ADDRESS).toBe(BASE_RAIL.asset);
    expect(BASE_CHAIN_ID).toBe(BASE_RAIL.chainId);
    expect(USDC_TEMPO_ADDRESS).toBe(TEMPO_RAIL.asset);
    expect(TEMPO_MAINNET_CHAIN_ID).toBe(TEMPO_RAIL.chainId);
  });

  it("advertises the x402 rail's network at the gate", () => {
    const accepts = buildPaymentConfig(
      workflow as Parameters<typeof buildPaymentConfig>[0],
      PAYEE
    ).accepts as unknown as Record<string, unknown>;
    expect(accepts.network).toBe(BASE_RAIL.network);
  });
});
