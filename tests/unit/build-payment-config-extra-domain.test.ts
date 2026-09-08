import { describe, expect, it } from "vitest";
import { buildPaymentConfig } from "@/lib/payments/x402/payment-gate";

const mockWorkflow = {
  priceUsdcPerCall: "1.00",
  listedSlug: "my-workflow",
  name: "My Workflow",
};

describe("buildPaymentConfig extra domain fields", () => {
  it("accepts.extra.name is 'USD Coin' (required for CDP facilitator EIP-712 verification)", () => {
    const config = buildPaymentConfig(
      mockWorkflow as Parameters<typeof buildPaymentConfig>[0],
      "0x1234000000000000000000000000000000005678"
    );
    const accepts = config.accepts as unknown as Record<string, unknown>;
    expect((accepts.extra as Record<string, unknown> | undefined)?.name).toBe(
      "USD Coin"
    );
  });

  it("accepts.extra.version is '2' (must match BASE_USDC_DOMAIN.version in sign.ts)", () => {
    const config = buildPaymentConfig(
      mockWorkflow as Parameters<typeof buildPaymentConfig>[0],
      "0x1234000000000000000000000000000000005678"
    );
    const accepts = config.accepts as unknown as Record<string, unknown>;
    expect(
      (accepts.extra as Record<string, unknown> | undefined)?.version
    ).toBe("2");
  });
});

describe("buildPaymentConfig price precision", () => {
  const configFor = (priceUsdcPerCall: string) =>
    buildPaymentConfig(
      { ...mockWorkflow, priceUsdcPerCall } as Parameters<
        typeof buildPaymentConfig
      >[0],
      "0x1234000000000000000000000000000000005678"
    ).accepts as unknown as Record<string, unknown>;

  it("keeps a sub-cent price at the precision it was listed with", () => {
    // Rounding to cents made the gate demand a different amount than the 402
    // advertised, so the payer's signed authorization matched no requirement
    // and every payment failed. The docs recommend pricing from $0.001.
    expect(configFor("0.005").price).toBe("$0.005");
  });

  it("keeps the smallest documented price out of zero", () => {
    expect(configFor("0.001").price).toBe("$0.001");
  });

  it("still passes through prices that are whole cents", () => {
    expect(configFor("1.00").price).toBe("$1.00");
    expect(configFor("0.05").price).toBe("$0.05");
  });

  it("falls back to zero when a listing has no price", () => {
    expect(
      (
        buildPaymentConfig(
          { ...mockWorkflow, priceUsdcPerCall: null } as unknown as Parameters<
            typeof buildPaymentConfig
          >[0],
          "0x1234000000000000000000000000000000005678"
        ).accepts as unknown as Record<string, unknown>
      ).price
    ).toBe("$0");
  });
});
