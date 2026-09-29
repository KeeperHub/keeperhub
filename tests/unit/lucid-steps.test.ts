import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

const { safeFetch, SsrfBlockedError } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch, SsrfBlockedError }));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { callEntrypointStep } from "@/plugins/lucid/steps/call-entrypoint";
import { discoverAgentStep } from "@/plugins/lucid/steps/discover-agent";
import {
  readAgentCard,
  readPaymentTerms,
} from "@/plugins/lucid/steps/lucid-core";

// Placeholder addresses: fixtures only, not real contracts or payees.
const ASSET = `0x${"a".repeat(40)}`;
const PAYEE = `0x${"b".repeat(40)}`;
const AGENT = "https://agent.example.com";

/**
 * The shape a running Lucid agent serves, abridged. It lists its capabilities
 * twice: an A2A `skills` array with no prices, and a keyed `entrypoints`
 * object that carries them. The asset appears once, under `payments`.
 */
const SERVED_CARD = {
  name: "counterparty-oracle",
  version: "1.0.0",
  description: "Free health check, priced verdict.",
  capabilities: {
    extensions: [{ uri: "https://x402.org" }, "urn:erc-8004"],
  },
  skills: [
    { id: "health", name: "health" },
    { id: "counterparty-check", name: "counterparty-check" },
  ],
  entrypoints: {
    health: {
      description: "Liveness check. Free.",
      input_schema: { type: "object", properties: {} },
    },
    "counterparty-check": {
      description: "Vouch for a payee.",
      input_schema: { type: "object", required: ["address"] },
      payment_protocol: "x402",
      network: "eip155:84532",
      pricing: { invoke: "10000" },
    },
  },
  payments: [
    {
      method: "x402",
      payee: PAYEE,
      network: "eip155:84532",
      extensions: {
        x402: {
          scheme: "exact",
          network: "eip155:84532",
          payTo: PAYEE,
          price: { amount: "10000", asset: ASSET },
        },
      },
    },
  ],
};

const CHALLENGE = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: `${AGENT}/entrypoints/counterparty-check/invoke` },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: ASSET,
      payTo: PAYEE,
      maxTimeoutSeconds: 300,
    },
  ],
};

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  safeFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: string;
  plugin?: string;
};

function lastCall(): { url: string; init: FetchInit } {
  const call = safeFetch.mock.calls.at(-1);
  return { url: call?.[0] as string, init: call?.[1] as FetchInit };
}

describe("readAgentCard", () => {
  it("prefers keyed entrypoints over the price-less skills array", () => {
    const card = readAgentCard(SERVED_CARD);
    expect(card.entrypoints.map((e) => e.name)).toEqual([
      "health",
      "counterparty-check",
    ]);
    const paid = card.entrypoints[1];
    expect(paid.priced).toBe(true);
    expect(paid.price).toBe("10000");
  });

  it("fills a priced entrypoint's asset and payee from the card's payments", () => {
    const paid = readAgentCard(SERVED_CARD).entrypoints[1];
    expect(paid.asset).toBe(ASSET);
    expect(paid.payTo).toBe(PAYEE);
    expect(paid.network).toBe("eip155:84532");
    expect(paid.inputSchema).toEqual({ type: "object", required: ["address"] });
  });

  it("does not give a free entrypoint the card's price", () => {
    const free = readAgentCard(SERVED_CARD).entrypoints[0];
    expect(free.priced).toBe(false);
    expect(free.price).toBeUndefined();
    expect(free.asset).toBeUndefined();
  });

  it("reads extensions given as strings or objects", () => {
    expect(readAgentCard(SERVED_CARD).extensions).toEqual([
      "https://x402.org",
      "urn:erc-8004",
    ]);
  });

  it("treats a payment marker without terms as priced", () => {
    const card = readAgentCard({
      entrypoints: [{ key: "mystery", paymentProtocol: "x402" }],
    });
    expect(card.entrypoints[0].priced).toBe(true);
  });

  it("reads x402 offers and bare prices", () => {
    const card = readAgentCard({
      entrypoints: [
        {
          key: "offer",
          x402: {
            offers: [
              {
                network: "eip155:8453",
                payTo: PAYEE,
                price: { amount: "500", asset: ASSET },
              },
            ],
          },
        },
        { key: "bare", price: 25 },
      ],
    });
    expect(card.entrypoints[0]).toMatchObject({
      priced: true,
      price: "500",
      asset: ASSET,
      network: "eip155:8453",
    });
    expect(card.entrypoints[1]).toMatchObject({ priced: true, price: "25" });
  });

  it("falls back to skills and drops entries without a key", () => {
    const card = readAgentCard({
      name: "a2a-only",
      skills: [{ id: "summarise" }, { description: "no key" }],
    });
    expect(card.entrypoints.map((e) => e.name)).toEqual(["summarise"]);
  });
});

describe("readPaymentTerms", () => {
  it("reads the first accepted requirement and the envelope's resource url", () => {
    expect(readPaymentTerms(CHALLENGE)).toEqual({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: ASSET,
      payTo: PAYEE,
      resource: `${AGENT}/entrypoints/counterparty-check/invoke`,
      description: undefined,
      maxTimeoutSeconds: 300,
    });
  });

  it("reads the v1 maxAmountRequired name", () => {
    expect(
      readPaymentTerms({ accepts: [{ maxAmountRequired: "7", payTo: PAYEE }] })
        ?.amount
    ).toBe("7");
  });

  it("returns null for something that is not payment terms", () => {
    expect(readPaymentTerms({})).toBeNull();
    expect(readPaymentTerms("nope")).toBeNull();
  });
});

describe("discoverAgentStep", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("fetches the well-known card without following redirects", async () => {
    respond(200, SERVED_CARD);

    const result = await discoverAgentStep({ agentUrl: `${AGENT}//` });

    const { url, init } = lastCall();
    expect(url).toBe(`${AGENT}/.well-known/agent-card.json`);
    expect(init.redirect).toBe("manual");
    expect(init.plugin).toBe("lucid");
    expect(result).toMatchObject({
      success: true,
      name: "counterparty-oracle",
      pricedEntrypoints: ["counterparty-check"],
    });
  });

  it("rejects a non-http agent URL before any request", async () => {
    const result = await discoverAgentStep({ agentUrl: "ftp://agent" });
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect instead of following it", async () => {
    respond(302, "", { location: "https://elsewhere.example.com" });
    const result = await discoverAgentStep({ agentUrl: AGENT });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
      httpStatus: 302,
    });
    if (!result.success) {
      expect(result.error).toContain("elsewhere.example.com");
    }
  });

  it("reports a card that is not JSON", async () => {
    respond(200, "<html>");
    const result = await discoverAgentStep({ agentUrl: AGENT });
    expect(result.success).toBe(false);
  });

  it("classifies a 5xx as external", async () => {
    respond(503, "down");
    const result = await discoverAgentStep({ agentUrl: AGENT });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
    });
  });

  it("reports an SSRF block as a user error", async () => {
    safeFetch.mockRejectedValueOnce(new SsrfBlockedError("private address"));
    const result = await discoverAgentStep({ agentUrl: AGENT });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
    });
  });
});

describe("callEntrypointStep", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("returns the output of a free entrypoint", async () => {
    respond(200, { output: { ok: true } });

    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "health",
      input: '{"verbose": true}',
    });

    const { url, init } = lastCall();
    expect(url).toBe(`${AGENT}/entrypoints/health/invoke`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body ?? "")).toEqual({ input: { verbose: true } });
    expect(init.headers?.["X-PAYMENT"]).toBeUndefined();
    expect(result).toMatchObject({
      success: true,
      status: "completed",
      output: { ok: true },
      paid: false,
    });
  });

  it("returns the terms of a 402 carried in a base64 header, without paying", async () => {
    respond(402, {}, { "payment-required": base64(CHALLENGE) });

    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
      input: { address: PAYEE },
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      status: "awaiting_payment",
      httpStatus: 402,
      payment: { amount: "10000", asset: ASSET, payTo: PAYEE },
      paymentRequired: CHALLENGE,
    });
  });

  it("reads 402 terms from the body when no header carries them", async () => {
    respond(402, CHALLENGE);
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({
      status: "awaiting_payment",
      payment: { amount: "10000" },
    });
  });

  it("still reports awaiting_payment when the terms cannot be read", async () => {
    respond(402, "pay up");
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({
      success: true,
      status: "awaiting_payment",
      payment: null,
      paymentRequired: "pay up",
    });
  });

  it("sends a payment header under both x402 names and returns the receipt", async () => {
    const receipt = { success: true, transaction: "0x01" };
    respond(
      200,
      { output: { vouched: true } },
      { "payment-response": base64(receipt) }
    );

    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
      input: { address: PAYEE },
      paymentHeader: " signed-payload ",
    });

    const { init } = lastCall();
    expect(init.headers?.["PAYMENT-SIGNATURE"]).toBe("signed-payload");
    expect(init.headers?.["X-PAYMENT"]).toBe("signed-payload");
    expect(result).toMatchObject({
      success: true,
      status: "completed",
      paid: true,
      paymentResponse: receipt,
    });
  });

  it("fails when a paid call is answered with another 402", async () => {
    respond(402, {}, { "payment-required": base64(CHALLENGE) });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
      paymentHeader: "signed-payload",
    });
    expect(result).toMatchObject({ success: false, httpStatus: 402 });
  });

  it("does not follow a redirect that would carry the payment elsewhere", async () => {
    respond(307, "", { location: "https://attacker.example.com" });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
      paymentHeader: "signed-payload",
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, httpStatus: 307 });
  });

  it("encodes the entrypoint key into the path", async () => {
    respond(200, { output: null });
    await callEntrypointStep({ agentUrl: AGENT, entrypoint: "a/../b" });
    expect(lastCall().url).toBe(`${AGENT}/entrypoints/a%2F..%2Fb/invoke`);
  });

  it("rejects input that is not a JSON object", async () => {
    const invalid = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "health",
      input: "{not json",
    });
    const array = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "health",
      input: "[1]",
    });
    expect(invalid.success).toBe(false);
    expect(array.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("requires an entrypoint", async () => {
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: " ",
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
    });
  });

  it("is never retried automatically", () => {
    expect(
      (callEntrypointStep as unknown as { maxRetries: number }).maxRetries
    ).toBe(0);
  });
});
