import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/turnkey/agentic-wallet", () => ({
  getTurnkeyClientForOrg: vi.fn(),
}));

const { featureEnabled, listedRows, safeFetch, assertUrlIsPublic, sign } =
  vi.hoisted(() => ({
    featureEnabled: { value: true },
    listedRows: { value: [] as { isListed: boolean }[] },
    safeFetch: vi.fn(),
    assertUrlIsPublic: vi.fn(),
    sign: vi.fn(),
  }));

vi.mock("@/lib/features/registry", () => ({
  getFeature: () => ({ enabled: featureEnabled.value }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: () => Promise.resolve(listedRows.value) }),
        }),
      }),
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", workflowId: "workflowId" },
  workflows: { id: "id", isListed: "isListed" },
}));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));

vi.mock("@/lib/safe-fetch", () => {
  class SsrfBlockedError extends Error {}
  return { safeFetch, assertUrlIsPublic, SsrfBlockedError };
});

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: () =>
    Promise.resolve({ success: true, organizationId: "org_1" }),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: () =>
    Promise.resolve({
      walletAddress: "0x2222222222222222222222222222222222222222",
      turnkeySubOrgId: "sub_1",
    }),
}));
vi.mock("@/lib/agentic-wallet/sign-typed-data", () => {
  class PolicyBlockedError extends Error {}
  class TurnkeyUpstreamError extends Error {}
  return {
    signTypedDataWithTurnkey: sign,
    PolicyBlockedError,
    TurnkeyUpstreamError,
  };
});

const { paidRequestCore } = await import(
  "@/plugins/web3/steps/paid-request-core"
);

const URL_ = "https://seller.example/resource";
const PAYEE = "0x1111111111111111111111111111111111111111";

function challenge(amount = "10000"): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: URL_ },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount,
        payTo: PAYEE,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  } as PaymentRequired;
}

function response(
  status: number,
  body = "",
  headers: Record<string, string> = {}
): Response {
  return new Response(status === 204 ? null : body, { status, headers });
}

function quote(amount?: string): Response {
  return response(402, "", {
    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge(amount)),
  });
}

const base = { url: URL_, maxPriceUsdc: "0.05" };

beforeEach(() => {
  vi.clearAllMocks();
  featureEnabled.value = true;
  listedRows.value = [];
  sign.mockResolvedValue(`0x${"cd".repeat(65)}`);
});

describe("paid request", () => {
  it("refuses when the feature is switched off", async () => {
    featureEnabled.value = false;
    const result = await paidRequestCore(base);
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("returns a free response without signing", async () => {
    safeFetch.mockResolvedValueOnce(response(200, '{"ok":true}'));
    const result = await paidRequestCore(base);
    expect(result).toMatchObject({
      success: true,
      paid: false,
      data: { ok: true },
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it("pays a quote within the max price and retries once with the payment", async () => {
    safeFetch
      .mockResolvedValueOnce(quote())
      .mockResolvedValueOnce(response(200, '{"answer":42}'));
    const result = await paidRequestCore(base);

    expect(result).toMatchObject({
      success: true,
      paid: true,
      data: { answer: 42 },
      payment: { amountUsdc: "0.010000" },
    });
    expect(safeFetch).toHaveBeenCalledTimes(2);
    const [, init] = safeFetch.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const payload = decodePaymentSignatureHeader(headers["PAYMENT-SIGNATURE"]);
    expect(
      (payload.payload.authorization as { to: string }).to.toLowerCase()
    ).toBe(PAYEE);
  });

  it("refuses a quote over the max price without signing", async () => {
    safeFetch.mockResolvedValueOnce(quote("60000"));
    const result = await paidRequestCore(base);
    expect(result.success).toBe(false);
    expect(sign).not.toHaveBeenCalled();
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a payee other than the expected one", async () => {
    safeFetch.mockResolvedValueOnce(quote());
    const result = await paidRequestCore({
      ...base,
      payTo: "0x3333333333333333333333333333333333333333",
    });
    expect(result.success).toBe(false);
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses inside a marketplace-listed workflow before any request", async () => {
    listedRows.value = [{ isListed: true }];
    const result = await paidRequestCore({
      ...base,
      _context: { executionId: "exec_1" },
    });
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("does not follow a redirect", async () => {
    safeFetch.mockResolvedValueOnce(
      response(302, "", { location: "https://elsewhere.example" })
    );
    const result = await paidRequestCore(base);
    expect(result.success).toBe(false);
    expect(sign).not.toHaveBeenCalled();
    const [, init] = safeFetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("checks the URL is public before every request", async () => {
    safeFetch
      .mockResolvedValueOnce(quote())
      .mockResolvedValueOnce(response(200, "{}"));
    await paidRequestCore(base);
    expect(assertUrlIsPublic).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing or zero max price", async () => {
    for (const maxPriceUsdc of ["", "0", "abc"]) {
      const result = await paidRequestCore({ ...base, maxPriceUsdc });
      expect(result.success).toBe(false);
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("fails on a 402 without an x402 challenge", async () => {
    safeFetch.mockResolvedValueOnce(response(402, "pay me"));
    const result = await paidRequestCore(base);
    expect(result.success).toBe(false);
    expect(sign).not.toHaveBeenCalled();
  });

  it("fails when the paid call is refused", async () => {
    safeFetch
      .mockResolvedValueOnce(quote())
      .mockResolvedValueOnce(response(402, ""));
    const result = await paidRequestCore(base);
    expect(result).toMatchObject({ success: false, httpStatus: 402 });
  });
});
