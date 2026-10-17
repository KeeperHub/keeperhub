import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/turnkey/agentic-wallet", () => ({
  getTurnkeyClientForOrg: vi.fn(),
}));

const { BASE_USDC_DOMAIN } = await import("@/lib/agentic-wallet/sign");
const {
  buildTransferAuthorization,
  MAX_PAYMENT_RAW,
  MAX_VALIDITY_SECONDS,
  parsePaymentRequired,
  selectRequirement,
  signPayment,
} = await import("@/lib/payments/x402/buyer");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYEE = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

function requirement(
  overrides: Partial<PaymentRequirements> = {}
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC_BASE,
    amount: "10000",
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

function challenge(accepts: PaymentRequirements[]): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://seller.example/resource" },
    accepts,
  } as PaymentRequired;
}

describe("parsePaymentRequired", () => {
  it("reads the challenge from the PAYMENT-REQUIRED header", () => {
    const headers = new Headers({
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
        challenge([requirement()])
      ),
    });
    expect(parsePaymentRequired(headers, "")?.accepts).toHaveLength(1);
  });

  it("falls back to a JSON body", () => {
    const body = JSON.stringify(challenge([requirement()]));
    expect(parsePaymentRequired(new Headers(), body)?.x402Version).toBe(2);
  });

  it("rejects a v1 challenge", () => {
    const body = JSON.stringify({ x402Version: 1, accepts: [] });
    expect(parsePaymentRequired(new Headers(), body)).toBeNull();
  });

  it("returns null for a body that is not a challenge", () => {
    expect(parsePaymentRequired(new Headers(), "not json")).toBeNull();
  });
});

describe("selectRequirement", () => {
  const limits = { maxAmountRaw: BigInt(50_000) };

  it("accepts a Base USDC exact requirement within the max price", () => {
    const result = selectRequirement(challenge([requirement()]), limits);
    expect(result).toMatchObject({ ok: true, amountRaw: BigInt(10_000) });
  });

  it("skips requirements on other networks or assets", () => {
    const result = selectRequirement(
      challenge([
        requirement({ network: "eip155:1" }),
        requirement({ asset: PAYEE }),
      ]),
      limits
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a price over the max price", () => {
    const result = selectRequirement(
      challenge([requirement({ amount: "50001" })]),
      limits
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a price over the hard per-payment ceiling", () => {
    const over = (MAX_PAYMENT_RAW + BigInt(1)).toString();
    const result = selectRequirement(
      challenge([requirement({ amount: over })]),
      {
        maxAmountRaw: MAX_PAYMENT_RAW * BigInt(2),
      }
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a zero or non-integer amount", () => {
    for (const amount of ["0", "1.5", "-1", "abc"]) {
      const result = selectRequirement(
        challenge([requirement({ amount })]),
        limits
      );
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a payee other than the expected one", () => {
    const result = selectRequirement(challenge([requirement()]), {
      ...limits,
      expectedPayTo: PAYER,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("matches the expected payee regardless of case", () => {
    const result = selectRequirement(challenge([requirement()]), {
      ...limits,
      expectedPayTo: PAYEE.toUpperCase().replace("0X", "0x"),
    });
    expect(result.ok).toBe(true);
  });
});

describe("buildTransferAuthorization", () => {
  it("signs the Base USDC domain whatever extra the seller sends", () => {
    const { typedData } = buildTransferAuthorization({
      from: PAYER,
      requirement: requirement({
        extra: { name: "Fake", version: "9" },
      }),
      nowSeconds: 1000,
      nonce: `0x${"ab".repeat(32)}`,
    });
    expect(typedData.domain).toEqual(BASE_USDC_DOMAIN);
    expect(typedData.primaryType).toBe("TransferWithAuthorization");
  });

  it("pays exactly the checked payee and amount", () => {
    const { authorization } = buildTransferAuthorization({
      from: PAYER,
      requirement: requirement(),
      nowSeconds: 1000,
      nonce: `0x${"ab".repeat(32)}`,
    });
    expect(authorization.to.toLowerCase()).toBe(PAYEE);
    expect(authorization.value).toBe("10000");
    expect(authorization.validBefore).toBe("1060");
  });

  it("caps the validity window", () => {
    const { authorization } = buildTransferAuthorization({
      from: PAYER,
      requirement: requirement({ maxTimeoutSeconds: 86_400 }),
      nowSeconds: 1000,
      nonce: `0x${"ab".repeat(32)}`,
    });
    expect(authorization.validBefore).toBe(String(1000 + MAX_VALIDITY_SECONDS));
  });
});

describe("signPayment", () => {
  it("wraps the signature as a decodable PAYMENT-SIGNATURE header", async () => {
    const sign = vi.fn().mockResolvedValue(`0x${"cd".repeat(65)}`);
    const req = requirement();
    const { header } = await signPayment({
      from: PAYER,
      paymentRequired: challenge([req]),
      requirement: req,
      sign,
      now: () => 1_000_000,
    });
    const decoded = decodePaymentSignatureHeader(header);
    expect(decoded.accepted).toEqual(req);
    expect(decoded.payload.signature).toBe(`0x${"cd".repeat(65)}`);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
