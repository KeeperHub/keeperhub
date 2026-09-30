import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

const { assertUrlIsPublic, safeFetch, SsrfBlockedError } = vi.hoisted(() => ({
  assertUrlIsPublic: vi.fn(),
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
vi.mock("@/lib/safe-fetch", () => ({
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
}));

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
const NETWORK = "eip155:84532";

/**
 * The card @lucid-agents/core 5 and @lucid-agents/payments 5 serve, abridged:
 * one free entrypoint, one priced in the canonical USD string form, and one
 * priced as a token amount. The price's unit and asset live only under
 * `payments[].extensions.x402`. The A2A `skills` list carries no prices.
 */
const SERVED_CARD = {
  protocolVersion: "1.0",
  name: "counterparty-oracle",
  version: "1.0.0",
  description: "Free health check, priced verdict.",
  capabilities: { streaming: false, pushNotifications: false },
  skills: [
    { id: "health", name: "health" },
    { id: "quote", name: "quote" },
    { id: "counterparty-check", name: "counterparty-check" },
  ],
  entrypoints: {
    health: {
      description: "Liveness check. Free.",
      streaming: false,
      input_schema: { type: "object", properties: {} },
    },
    quote: {
      description: "Priced in USD.",
      streaming: false,
      payment_protocol: "x402",
      network: NETWORK,
      pricing: { invoke: "0.01" },
    },
    "counterparty-check": {
      description: "Vouch for a payee.",
      streaming: false,
      input_schema: { type: "object", required: ["address"] },
      payment_protocol: "x402",
      network: NETWORK,
      pricing: { invoke: "10000" },
    },
  },
  payments: [
    {
      method: "x402",
      payee: PAYEE,
      network: NETWORK,
      priceModel: { default: "10000" },
      extensions: {
        x402: {
          scheme: "exact",
          network: NETWORK,
          payTo: PAYEE,
          price: { amount: "10000", asset: ASSET },
        },
      },
    },
    {
      method: "x402",
      payee: PAYEE,
      network: NETWORK,
      priceModel: { default: "0.01" },
      extensions: {
        x402: {
          scheme: "exact",
          network: NETWORK,
          price: "0.01",
          payTo: PAYEE,
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
      network: NETWORK,
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

function entrypoint(name: string): unknown {
  return readAgentCard(SERVED_CARD)?.entrypoints.find(
    (item) => item.name === name
  );
}

describe("readAgentCard", () => {
  it("lists the keyed entrypoints, not the skills array", () => {
    const card = readAgentCard(SERVED_CARD);
    expect(card?.name).toBe("counterparty-oracle");
    expect(card?.entrypoints.map((item) => item.name)).toEqual([
      "health",
      "quote",
      "counterparty-check",
    ]);
  });

  it("reports a USD price as usd, with no asset", () => {
    expect(entrypoint("quote")).toEqual({
      name: "quote",
      description: "Priced in USD.",
      priced: true,
      price: "0.01",
      priceUnit: "usd",
      asset: undefined,
      network: NETWORK,
      payTo: PAYEE,
      inputSchema: undefined,
    });
  });

  it("reports a token price in base units with its asset", () => {
    expect(entrypoint("counterparty-check")).toMatchObject({
      priced: true,
      price: "10000",
      priceUnit: "base_units",
      asset: ASSET,
      payTo: PAYEE,
    });
  });

  it("gives a free entrypoint no price", () => {
    expect(entrypoint("health")).toEqual({
      name: "health",
      description: "Liveness check. Free.",
      priced: false,
      inputSchema: { type: "object", properties: {} },
    });
  });

  it("leaves the unit unset when no payment method matches the price", () => {
    const card = readAgentCard({
      entrypoints: {
        x: { payment_protocol: "x402", pricing: { invoke: "5" } },
      },
    });
    expect(card?.entrypoints[0]).toMatchObject({
      priced: true,
      price: "5",
      priceUnit: undefined,
    });
  });

  it("treats a payment marker without a price as priced", () => {
    const card = readAgentCard({
      entrypoints: { x: { payment_protocol: "x402" } },
    });
    expect(card?.entrypoints[0]).toMatchObject({ priced: true });
  });

  it("uses the object key, not a key field inside the entry", () => {
    const card = readAgentCard({
      entrypoints: { "free-health": { key: "expensive-verdict" } },
    });
    expect(card?.entrypoints[0]?.name).toBe("free-health");
  });

  it("returns null for JSON that is not a Lucid card", () => {
    expect(readAgentCard({ url: "https://httpbin.org/anything" })).toBeNull();
    expect(readAgentCard({ skills: [{ id: "a" }] })).toBeNull();
    expect(readAgentCard(null)).toBeNull();
  });
});

describe("readPaymentTerms", () => {
  it("reads the first accepted requirement and the envelope's resource url", () => {
    expect(readPaymentTerms(CHALLENGE)).toMatchObject({
      scheme: "exact",
      amount: "10000",
      asset: ASSET,
      payTo: PAYEE,
      resource: `${AGENT}/entrypoints/counterparty-check/invoke`,
      maxTimeoutSeconds: 300,
    });
  });

  it("reads the v1 maxAmountRequired name", () => {
    expect(
      readPaymentTerms({ accepts: [{ maxAmountRequired: "5", payTo: PAYEE }] })
    ).toMatchObject({ amount: "5" });
  });

  it("returns null for something that is not payment terms", () => {
    expect(readPaymentTerms({})).toBeNull();
    expect(readPaymentTerms("nope")).toBeNull();
  });
});

describe("discoverAgentStep", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    assertUrlIsPublic.mockReset();
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
      pricedEntrypoints: ["quote", "counterparty-check"],
    });
  });

  it("fails on JSON that is not an agent card", async () => {
    respond(200, { url: "https://httpbin.org/anything", headers: {} });
    const result = await discoverAgentStep({ agentUrl: AGENT });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
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

  it("checks the URL is public before fetching", async () => {
    respond(200, SERVED_CARD);
    await discoverAgentStep({ agentUrl: AGENT });
    expect(assertUrlIsPublic).toHaveBeenCalledWith(
      `${AGENT}/.well-known/agent-card.json`
    );
  });

  it("blocks an internal agent URL without fetching", async () => {
    assertUrlIsPublic.mockRejectedValueOnce(
      new SsrfBlockedError("private address")
    );
    const result = await discoverAgentStep({ agentUrl: "http://10.0.0.5" });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("callEntrypointStep", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    assertUrlIsPublic.mockReset();
  });

  it("returns the output of a free entrypoint", async () => {
    respond(200, {
      run_id: "run-1",
      status: "succeeded",
      output: { ok: true },
    });

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
    expect(result).toEqual({
      success: true,
      status: "completed",
      httpStatus: 200,
      output: { ok: true },
      runId: "run-1",
    });
  });

  it("sends no payment headers", async () => {
    respond(200, { output: {} });
    await callEntrypointStep({ agentUrl: AGENT, entrypoint: "health" });
    const { init } = lastCall();
    expect(Object.keys(init.headers ?? {}).sort()).toEqual([
      "Accept",
      "Content-Type",
    ]);
  });

  it("calls the agent with input that itself says success: false", async () => {
    respond(200, { output: { recorded: true } });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "record-build",
      input: '{"success": false, "note": "build failed"}',
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastCall().init.body ?? "")).toEqual({
      input: { success: false, note: "build failed" },
    });
    expect(result).toMatchObject({
      success: true,
      output: { recorded: true },
    });
  });

  it("fails on a 2xx that is not an entrypoint result", async () => {
    respond(200, { url: `${AGENT}/anything`, json: { input: {} } });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "health",
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
      httpStatus: 200,
    });
  });

  it("returns the terms of a 402 carried in a base64 header", async () => {
    respond(402, {}, { "payment-required": base64(CHALLENGE) });

    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
      input: { address: PAYEE },
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      status: "awaiting_payment",
      httpStatus: 402,
      payment: expect.objectContaining({
        amount: "10000",
        asset: ASSET,
        payTo: PAYEE,
      }),
      challenge: CHALLENGE,
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
      challenge: "pay up",
    });
  });

  it("does not follow a redirect", async () => {
    respond(307, "", { location: "https://elsewhere.example.com" });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({ success: false, httpStatus: 307 });
    expect(safeFetch).toHaveBeenCalledTimes(1);
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

  it("blocks an internal agent URL without calling it", async () => {
    assertUrlIsPublic.mockRejectedValueOnce(
      new SsrfBlockedError("private address")
    );
    const result = await callEntrypointStep({
      agentUrl: "http://169.254.169.254",
      entrypoint: "health",
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("is never retried automatically", () => {
    expect(
      (callEntrypointStep as unknown as { maxRetries: number }).maxRetries
    ).toBe(0);
  });
});
