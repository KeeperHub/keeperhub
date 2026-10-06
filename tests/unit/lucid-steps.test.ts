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
import { BASE_RAIL } from "@/lib/payments/rails";
import { callEntrypointStep } from "@/plugins/lucid/steps/call-entrypoint";
import { discoverAgentStep } from "@/plugins/lucid/steps/discover-agent";
import {
  DISCOVER_TIMEOUT_MS,
  INVOKE_TIMEOUT_MS,
  readAgentCard,
  readPaymentTerms,
} from "@/plugins/lucid/steps/lucid-core";

// Placeholder addresses: fixtures only, not real contracts or payees.
const ASSET = `0x${"a".repeat(40)}`;
const PAYEE = `0x${"b".repeat(40)}`;
const AGENT = "https://agent.example.com";
const NETWORK = "eip155:84532";

/**
 * A Lucid agent card, abridged: one free entrypoint, one priced in the
 * canonical USD string form, and one priced as a token amount. The price's
 * unit and asset live only under `payments[].extensions.x402`. The A2A
 * `skills` list carries no prices.
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
  signal?: AbortSignal;
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
  it.each([
    ["a decimal stated as base units", "0.000001"],
    ["a non-numeric price", "not-a-number"],
  ])("reports %s as an unknown unit", (_label, price) => {
    const card = readAgentCard({
      entrypoints: { paid: { pricing: { invoke: price } } },
      payments: [
        {
          extensions: { x402: { price: { amount: price, asset: "0xabc" } } },
        },
      ],
    });
    expect(card?.entrypoints[0]).toMatchObject({
      priced: true,
      price,
      priceUnit: "unknown",
    });
  });

  it("keeps a well-formed base-units price as base units", () => {
    const card = readAgentCard({
      entrypoints: { paid: { pricing: { invoke: "10000" } } },
      payments: [
        {
          extensions: { x402: { price: { amount: "10000", asset: "0xabc" } } },
        },
      ],
    });
    expect(card?.entrypoints[0]).toMatchObject({
      priceUnit: "base_units",
      asset: "0xabc",
    });
  });

  it("reports a non-numeric usd price as an unknown unit", () => {
    const card = readAgentCard({
      entrypoints: { paid: { pricing: { invoke: "not-a-number" } } },
      payments: [{ extensions: { x402: { price: "not-a-number" } } }],
    });
    expect(card?.entrypoints[0]).toMatchObject({ priceUnit: "unknown" });
  });

  it("lists the keyed entrypoints, not the skills array", () => {
    const card = readAgentCard(SERVED_CARD);
    expect(card?.name).toBe("counterparty-oracle");
    expect(card?.version).toBe("1.0.0");
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

  it("reports the unit as unknown when no payment method matches the price", () => {
    const card = readAgentCard({
      entrypoints: {
        x: { payment_protocol: "x402", pricing: { invoke: "5" } },
      },
    });
    expect(card?.entrypoints[0]).toMatchObject({
      priced: true,
      price: "5",
      priceUnit: "unknown",
    });
  });

  it("finds a price published only under priceModel, with an unknown unit", () => {
    const card = readAgentCard({
      entrypoints: {
        x: { payment_protocol: "x402", pricing: { invoke: "10000" } },
      },
      payments: [
        { method: "x402", payee: PAYEE, priceModel: { default: "10000" } },
      ],
    });
    expect(card?.entrypoints[0]).toMatchObject({
      price: "10000",
      priceUnit: "unknown",
      payTo: PAYEE,
    });
  });

  it("reports unknown when two offers state the same price in different units", () => {
    const card = readAgentCard({
      entrypoints: {
        x: { payment_protocol: "x402", pricing: { invoke: "10000" } },
      },
      payments: [
        { method: "x402", extensions: { x402: { price: "10000" } } },
        {
          method: "x402",
          extensions: { x402: { price: { amount: "10000", asset: ASSET } } },
        },
      ],
    });
    expect(card?.entrypoints[0]).toMatchObject({ priceUnit: "unknown" });
  });

  it("ignores an offer stated for another network", () => {
    const card = readAgentCard({
      entrypoints: {
        x: {
          payment_protocol: "x402",
          network: NETWORK,
          pricing: { invoke: "10000" },
        },
      },
      payments: [
        {
          method: "x402",
          network: "eip155:1",
          extensions: {
            x402: {
              network: "eip155:1",
              price: { amount: "10000", asset: ASSET },
            },
          },
        },
      ],
    });
    expect(card?.entrypoints[0]).toMatchObject({
      priceUnit: "unknown",
      asset: undefined,
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

  it("refuses an amount that is not an integer count of base units", () => {
    expect(
      readPaymentTerms({ accepts: [{ amount: "0.01", payTo: PAYEE }] })
    ).toMatchObject({ amount: undefined, amountRejected: "0.01" });
  });

  it("keeps a base-units integer and leaves nothing rejected", () => {
    expect(readPaymentTerms(CHALLENGE)).toMatchObject({
      amount: "10000",
      amountRejected: undefined,
    });
  });

  it("returns the rail's decimals for a known network", () => {
    expect(
      readPaymentTerms({
        accepts: [
          {
            amount: "10000",
            asset: BASE_RAIL.asset.toLowerCase(),
            network: BASE_RAIL.network,
            payTo: PAYEE,
          },
        ],
      })
    ).toMatchObject({ assetDecimals: 6, assetMismatch: false });
  });

  it("flags an asset that is not the rail's settlement asset", () => {
    expect(
      readPaymentTerms({
        accepts: [
          {
            amount: "10000",
            asset: ASSET,
            network: BASE_RAIL.network,
            payTo: PAYEE,
          },
        ],
      })
    ).toMatchObject({ assetDecimals: undefined, assetMismatch: true });
  });

  it("states no decimals for a known rail the challenge names no asset for", () => {
    expect(
      readPaymentTerms({
        accepts: [
          { amount: "1000000", payTo: PAYEE, network: BASE_RAIL.network },
        ],
      })
    ).toMatchObject({ assetDecimals: undefined, assetMismatch: true });
  });

  it("resolves no rail from a property name every object carries", () => {
    expect(
      readPaymentTerms({
        accepts: [
          {
            amount: "10000",
            asset: ASSET,
            network: "constructor",
            payTo: PAYEE,
          },
        ],
      })
    ).toMatchObject({ assetDecimals: undefined, assetMismatch: undefined });
  });

  it("publishes no amount when the offers state different amounts", () => {
    expect(
      readPaymentTerms({
        accepts: [{ amount: "1" }, { amount: "999999999999" }],
      })
    ).toMatchObject({
      offerCount: 2,
      amount: undefined,
      amountRejected: "1, 999999999999",
    });
  });

  it("publishes no amount when the two amount keys disagree", () => {
    expect(
      readPaymentTerms({ maxAmountRequired: "1", amount: "999999999" })
    ).toMatchObject({ amount: undefined, amountRejected: "1, 999999999" });
  });

  it("keeps the amount when every offer states the same one", () => {
    expect(
      readPaymentTerms({
        accepts: [{ amount: "10000", payTo: PAYEE }, { amount: "10000" }],
      })
    ).toMatchObject({ amount: "10000", offerCount: 2 });
  });

  it("counts the offers the challenge states", () => {
    expect(readPaymentTerms(CHALLENGE)).toMatchObject({ offerCount: 1 });
  });

  it("states no decimals for a network that is not a known rail", () => {
    expect(readPaymentTerms(CHALLENGE)).toMatchObject({
      assetDecimals: undefined,
      assetMismatch: undefined,
    });
  });

  it("states no amount when two offers price it on different assets", () => {
    expect(
      readPaymentTerms({
        accepts: [
          { amount: "1000000", network: "eip155:8453", asset: "0xaaa" },
          { amount: "1000000", network: "eip155:1", asset: "0xbbb" },
        ],
      })
    ).toMatchObject({
      amount: undefined,
      amountRejected: "1000000",
      offerCount: 2,
    });
  });

  it("states no offers for an empty accepts list", () => {
    expect(
      readPaymentTerms({ accepts: [], payTo: PAYEE, amount: "1000000" })
    ).toMatchObject({ offerCount: 0 });
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

  it("drops a query and fragment instead of letting them swallow the path", async () => {
    respond(200, SERVED_CARD);
    await discoverAgentStep({ agentUrl: `${AGENT}/base/?token=x#frag` });
    expect(lastCall().url).toBe(`${AGENT}/base/.well-known/agent-card.json`);
  });

  it("refuses an agent URL carrying credentials", async () => {
    const result = await discoverAgentStep({
      agentUrl: "https://user:pw@agent.example.com",
    });
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
    if (!result.success) {
      expect(result.error).not.toContain("pw");
    }
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

  it("bounds the request with an abort signal", async () => {
    respond(200, SERVED_CARD);
    await discoverAgentStep({ agentUrl: AGENT });
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps both timeouts within workable bounds", () => {
    expect(DISCOVER_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(DISCOVER_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(INVOKE_TIMEOUT_MS).toBeGreaterThanOrEqual(DISCOVER_TIMEOUT_MS);
    expect(INVOKE_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("caps the error body it echoes back", async () => {
    respond(500, `${"A".repeat(500)}TAIL`);
    const result = await discoverAgentStep({ agentUrl: AGENT });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("A".repeat(300));
      expect(result.error).not.toContain("TAIL");
      expect(result.error.length).toBeLessThan(400);
    }
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
      agentStatus: "succeeded",
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

  it("fails a run the agent itself reports as failed", async () => {
    respond(200, {
      run_id: "run-2",
      status: "failed",
      output: null,
      error: "upstream oracle unreachable",
    });

    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });

    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
      agentStatus: "failed",
      runId: "run-2",
    });
    if (!result.success) {
      expect(result.error).toContain("upstream oracle unreachable");
    }
  });

  it("never reports completed for a status it does not recognise", async () => {
    respond(200, { status: "cancelled", output: { partial: true } });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({ success: false, agentStatus: "cancelled" });
  });

  it("completes an envelope that states no status", async () => {
    respond(200, { output: { ok: true } });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "health",
    });
    expect(result).toMatchObject({
      success: true,
      status: "completed",
      agentStatus: undefined,
    });
  });

  it("fails a run whose status is not a string", async () => {
    respond(200, { output: { partial: true }, status: { state: "failed" } });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error).toContain("failed");
    }
  });

  it("fails a run whose status is served as a boolean", async () => {
    respond(200, { output: { partial: true }, status: false });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({ success: false, agentStatus: "false" });
  });

  it("fails an envelope that carries an error and states no status", async () => {
    respond(200, { output: null, error: { code: "E", message: "boom" } });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
    });
    if (!result.success) {
      expect(result.error).toContain("boom");
    }
  });

  it("surfaces an error served beside a succeeded status", async () => {
    respond(200, {
      output: null,
      status: "succeeded",
      error: { code: "E", message: "boom" },
    });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({ success: false, agentStatus: "succeeded" });
    if (!result.success) {
      expect(result.error).toContain("boom");
    }
  });

  it.each([
    ["a numeric code", { code: 503 }],
    ["an unknown key", { detail: "upstream died" }],
    ["an array", ["timeout"]],
    ["a number", 500],
    ["a boolean", true],
  ])("fails a succeeded run carrying an error as %s", async (_label, error) => {
    respond(200, { output: 1, status: "succeeded", error });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.EXTERNAL,
    });
  });

  it("fails an unreadable error served with no status", async () => {
    respond(200, { output: 1, error: { code: 503 } });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error).toContain("503");
    }
  });

  it.each([null, ""])("completes a run whose error is %p", async (error) => {
    respond(200, { output: 1, status: "succeeded", error });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
    });
    expect(result).toMatchObject({ success: true, output: 1 });
  });

  it.each([5, true])("refuses a native scalar input: %p", async (raw) => {
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "counterparty-check",
      input: raw as never,
    });
    expect(result).toMatchObject({
      success: false,
      errorClass: ExecutionErrorType.USER,
    });
    if (!result.success) {
      expect(result.error).toContain("Input must be a JSON object");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("completes a succeeded status whatever its case and spacing", async () => {
    respond(200, { output: { ok: true }, status: " Succeeded " });
    const result = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "health",
    });
    expect(result).toMatchObject({
      success: true,
      status: "completed",
      agentStatus: " Succeeded ",
    });
  });

  it("bounds the invoke with an abort signal", async () => {
    respond(200, { output: null });
    await callEntrypointStep({ agentUrl: AGENT, entrypoint: "health" });
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
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
    const nativeArray = await callEntrypointStep({
      agentUrl: AGENT,
      entrypoint: "health",
      input: [1] as unknown as Record<string, unknown>,
    });
    expect(invalid.success).toBe(false);
    expect(array.success).toBe(false);
    expect(nativeArray.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("treats a written null, blank and empty input as no input", async () => {
    const sent: unknown[] = [];
    for (const value of ["null", "   ", ""]) {
      respond(200, { output: null });
      const result = await callEntrypointStep({
        agentUrl: AGENT,
        entrypoint: "health",
        input: value,
      });
      expect(result.success).toBe(true);
      sent.push(JSON.parse(lastCall().init.body ?? ""));
    }
    expect(sent).toEqual([{ input: {} }, { input: {} }, { input: {} }]);
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
