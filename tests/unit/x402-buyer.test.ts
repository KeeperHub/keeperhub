import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BASE_RAIL } from "@/lib/payments/rails";
import {
  buildAuthorizationTypedData,
  checkQuote,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  MAX_PAYMENT_USDC_RAW,
  parseUsdcToRaw,
} from "@/lib/payments/x402/buyer";

const PAYEE = "0x1111111111111111111111111111111111111111";
const OTHER_PAYEE = "0x2222222222222222222222222222222222222222";
const USDC = BASE_RAIL.asset;

function v2Body(accepts: unknown[], x402Version = 2): unknown {
  return { x402Version, accepts };
}

function exactRequirement(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "10000",
    asset: USDC,
    payTo: PAYEE,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

describe("parseUsdcToRaw", () => {
  it("parses human USDC amounts to 6-decimal raw units", () => {
    expect(parseUsdcToRaw("0.25")).toBe(BigInt(250_000));
    expect(parseUsdcToRaw("1")).toBe(BigInt(1_000_000));
    expect(parseUsdcToRaw("100")).toBe(BigInt(100_000_000));
    expect(parseUsdcToRaw("0.000001")).toBe(BigInt(1));
  });

  it("rejects non-positive, malformed, and over-precise amounts", () => {
    for (const bad of [
      "",
      "abc",
      "-1",
      "0",
      "0.00",
      "0.0000001",
      "1e5",
      " 1",
      "1 ",
      "+1",
      ".5",
      "1.2345678",
    ]) {
      expect(parseUsdcToRaw(bad), bad).toBeNull();
    }
  });
});

describe("checkQuote", () => {
  const opts = { maxPriceUsdc: "1" };

  it("accepts a valid v2 exact/USDC/Base quote under the max price", () => {
    const result = checkQuote(v2Body([exactRequirement()]), opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.amountRaw).toBe(BigInt(10_000));
      expect(result.quote.payTo).toBe(PAYEE);
      expect(result.quote.validitySeconds).toBe(300);
    }
  });

  it("refuses non-v2 challenges", () => {
    for (const body of [
      v2Body([exactRequirement()], 1),
      { accepts: [exactRequirement()] },
      "not an object",
      null,
    ]) {
      const result = checkQuote(body, opts);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("NOT_X402_V2");
      }
    }
  });

  it("refuses an empty accepts list", () => {
    const result = checkQuote(v2Body([]), opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_ACCEPTABLE_REQUIREMENT");
    }
  });

  it("refuses wrong scheme, network, or asset", () => {
    const bad = [
      exactRequirement({ scheme: "upto" }),
      exactRequirement({ scheme: "exact", network: "eip155:1" }),
      exactRequirement({ asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }),
      exactRequirement({ asset: "not-an-address" }),
    ];
    for (const entry of bad) {
      const result = checkQuote(v2Body([entry]), opts);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("NO_ACCEPTABLE_REQUIREMENT");
      }
    }
  });

  it("accepts the asset case-insensitively", () => {
    const result = checkQuote(
      v2Body([exactRequirement({ asset: USDC.toLowerCase() })]),
      opts
    );
    expect(result.ok).toBe(true);
  });

  it("refuses malformed amount, payee, and validity fields", () => {
    const bad = [
      exactRequirement({ amount: "0" }),
      exactRequirement({ amount: "-5" }),
      exactRequirement({ amount: "10.5" }),
      exactRequirement({ amount: 10_000 }),
      exactRequirement({ payTo: "not-an-address" }),
      exactRequirement({ payTo: "0x1234" }),
      exactRequirement({ maxTimeoutSeconds: 0 }),
      exactRequirement({ maxTimeoutSeconds: -10 }),
      exactRequirement({ maxTimeoutSeconds: "300" }),
      {},
    ];
    for (const entry of bad) {
      const result = checkQuote(v2Body([entry]), opts);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a quote at or above the step max price", () => {
    // 1 USDC == max price of "1": not under, so refused.
    const atMax = checkQuote(
      v2Body([exactRequirement({ amount: "1000000" })]),
      opts
    );
    expect(atMax.ok).toBe(false);
    if (!atMax.ok) {
      expect(atMax.code).toBe("AMOUNT_EXCEEDS_MAX_PRICE");
    }
    const above = checkQuote(
      v2Body([exactRequirement({ amount: "1000001" })]),
      opts
    );
    expect(above.ok).toBe(false);
    if (!above.ok) {
      expect(above.code).toBe("AMOUNT_EXCEEDS_MAX_PRICE");
    }
  });

  it("refuses a quote at or above the 100 USDC ceiling", () => {
    expect(MAX_PAYMENT_USDC_RAW).toBe(BigInt(100_000_000));
    const atCeiling = checkQuote(
      v2Body([exactRequirement({ amount: "100000000" })]),
      { maxPriceUsdc: "1000" }
    );
    expect(atCeiling.ok).toBe(false);
    if (!atCeiling.ok) {
      expect(atCeiling.code).toBe("AMOUNT_EXCEEDS_CEILING");
    }
  });

  it("refuses an invalid step max price without signing", () => {
    const result = checkQuote(v2Body([exactRequirement()]), {
      maxPriceUsdc: "bogus",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_MAX_PRICE");
    }
  });

  it("enforces the optional expected payee", () => {
    const mismatch = checkQuote(v2Body([exactRequirement()]), {
      maxPriceUsdc: "1",
      expectedPayTo: OTHER_PAYEE,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.code).toBe("PAYEE_MISMATCH");
    }

    // Case-insensitive match is accepted.
    const match = checkQuote(v2Body([exactRequirement()]), {
      maxPriceUsdc: "1",
      expectedPayTo: PAYEE.toLowerCase(),
    });
    expect(match.ok).toBe(true);

    // No expected payee: any payee is accepted.
    const unset = checkQuote(
      v2Body([exactRequirement({ payTo: OTHER_PAYEE })]),
      opts
    );
    expect(unset.ok).toBe(true);
  });

  it("caps validity at 10 minutes and floors fractional seconds", () => {
    const capped = checkQuote(
      v2Body([exactRequirement({ maxTimeoutSeconds: 3600 })]),
      opts
    );
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.quote.validitySeconds).toBe(600);
    }
    const floored = checkQuote(
      v2Body([exactRequirement({ maxTimeoutSeconds: 61.9 })]),
      opts
    );
    expect(floored.ok).toBe(true);
    if (floored.ok) {
      expect(floored.quote.validitySeconds).toBe(61);
    }
  });

  it("picks the first acceptable requirement, skipping unacceptable ones", () => {
    const result = checkQuote(
      v2Body([
        exactRequirement({ scheme: "upto" }),
        exactRequirement({ network: "eip155:1" }),
        exactRequirement({ amount: "5000", payTo: OTHER_PAYEE }),
      ]),
      opts
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.amountRaw).toBe(BigInt(5000));
      expect(result.quote.payTo).toBe(OTHER_PAYEE);
    }
  });
});

describe("buildAuthorizationTypedData", () => {
  const quote = {
    amountRaw: BigInt(10_000),
    payTo: PAYEE,
    validitySeconds: 300,
  };
  const from = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it("builds the EIP-3009 typed-data from the checked quote", () => {
    const nowSec = 1_700_000_000;
    const { typedData, authorization } = buildAuthorizationTypedData(
      quote,
      from,
      nowSec
    );
    expect(typedData.primaryType).toBe("TransferWithAuthorization");
    expect(authorization).toEqual({
      from,
      to: PAYEE,
      value: "10000",
      validAfter: "0",
      validBefore: String(nowSec + 300),
      nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(typedData.message).toEqual(authorization);
  });

  it("uses the rail's USDC domain and types, not the seller's extra/asset", () => {
    const { typedData } = buildAuthorizationTypedData(quote, from);
    const domain = typedData.domain as Record<string, unknown>;
    expect(domain.name).toBe("USD Coin");
    expect(domain.version).toBe("2");
    expect(domain.chainId).toBe(8453);
    expect(domain.verifyingContract).toBe(BASE_RAIL.asset);
    const types = typedData.types as Record<
      string,
      { name: string; type: string }[]
    >;
    expect(types.TransferWithAuthorization?.map((f) => f.name)).toEqual([
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]);
    // The seller's asset string appears nowhere in the signed payload.
    expect(JSON.stringify(typedData)).not.toContain("deadbeef");
  });

  it("mints a fresh random nonce per authorization", () => {
    const a = buildAuthorizationTypedData(quote, from).authorization.nonce;
    const b = buildAuthorizationTypedData(quote, from).authorization.nonce;
    expect(a).not.toBe(b);
  });
});

describe("encodePaymentSignatureHeader", () => {
  it("encodes the v2 PaymentPayload as base64", () => {
    const authorization = {
      from: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      to: PAYEE,
      value: "10000",
      validAfter: "0",
      validBefore: "1700000300",
      nonce: "0x1234",
    };
    const header = encodePaymentSignatureHeader("0xdeadbeef", authorization);
    const decoded = JSON.parse(
      Buffer.from(header, "base64").toString("utf-8")
    ) as {
      x402Version: number;
      payload: { signature: string; authorization: unknown };
    };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.payload.signature).toBe("0xdeadbeef");
    expect(decoded.payload.authorization).toEqual(authorization);
  });
});

describe("decodePaymentRequiredHeader", () => {
  it("decodes a base64 payment-required header", () => {
    const required = { x402Version: 2, accepts: [exactRequirement()] };
    const header = Buffer.from(JSON.stringify(required), "utf-8").toString(
      "base64"
    );
    expect(decodePaymentRequiredHeader(header)).toEqual(required);
  });

  it("returns null for absent or undecodable headers", () => {
    expect(decodePaymentRequiredHeader(null)).toBeNull();
    expect(decodePaymentRequiredHeader("")).toBeNull();
    expect(decodePaymentRequiredHeader("!!!not-json!!!")).toBeNull();
  });
});
