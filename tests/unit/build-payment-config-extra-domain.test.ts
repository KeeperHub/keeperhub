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
