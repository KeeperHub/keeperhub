import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { signPaymentStep } from "@/plugins/agent-gateway/steps/sign-payment";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const CHALLENGE = { payTo: "0xabc", amount: "500000", nonce: "0x01" };

const baseInput = {
  integrationId: "int-1",
  _context: {
    nodeId: "node-1",
    nodeName: "Sign Payment",
    nodeType: "agent-gateway/sign-payment",
    organizationId: "org-1",
  },
  chain: "base" as const,
  workflowSlug: "my-workflow",
  paymentChallenge: CHALLENGE,
};

function sentBody() {
  const [, options] = safeFetch.mock.calls[0] as [string, { body?: string }];
  return JSON.parse(options.body ?? "{}") as Record<string, unknown>;
}

describe("agent-gateway sign-payment step", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    mockFetchCredentials.mockReset();
    mockFetchCredentials.mockResolvedValue({
      AGENT_GATEWAY_SUB_ORG_ID: "su-1",
      AGENT_GATEWAY_HMAC_SECRET: "test-secret",
    });
  });

  it("does not auto-retry", () => {
    expect(signPaymentStep.maxRetries).toBe(0);
  });

  it("returns status=signed on a 200 with a signature", async () => {
    safeFetch.mockResolvedValue(jsonResponse(200, { signature: "0xdeadbeef" }));

    const result = await signPaymentStep(baseInput);

    expect(result).toEqual({
      success: true,
      status: "signed",
      signature: "0xdeadbeef",
    });

    expect(mockFetchCredentials).toHaveBeenCalledWith("int-1", {
      organizationId: "org-1",
    });

    const [, options] = safeFetch.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string> },
    ];
    expect(options.method).toBe("POST");
    expect(options.headers?.["X-KH-Sub-Org"]).toBe("su-1");
  });

  it("returns status=pending_approval on a 202", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(202, { approvalRequestId: "areq-1" })
    );

    const result = await signPaymentStep(baseInput);

    expect(result).toEqual({
      success: true,
      status: "pending_approval",
      approvalRequestId: "areq-1",
    });
  });

  it("returns status=blocked (not a thrown error) on a 403", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(403, {
        error: "Risk threshold exceeded",
        code: "RISK_BLOCKED",
      })
    );

    const result = await signPaymentStep(baseInput);

    expect(result).toEqual({
      success: false,
      status: "blocked",
      error: "Risk threshold exceeded",
      code: "RISK_BLOCKED",
    });
  });

  it("rejects a missing paymentChallenge before ever calling out", async () => {
    const result = await signPaymentStep({
      ...baseInput,
      paymentChallenge: undefined,
    });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses to call out when no integration is selected", async () => {
    const result = await signPaymentStep({
      ...baseInput,
      integrationId: undefined,
    });

    expect(result.success).toBe(false);
    expect(mockFetchCredentials).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  // The endpoint answers 400 WORKFLOW_SLUG_REQUIRED without one, so the round
  // trip is guaranteed to fail; fail fast with a message that names the field.
  it("rejects a blank workflowSlug before ever calling out", async () => {
    const result = await signPaymentStep({ ...baseInput, workflowSlug: "" });

    expect(result).toMatchObject({
      success: false,
      status: "error",
      code: "WORKFLOW_SLUG_REQUIRED",
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  // The json-editor config field hands the step a JSON string. Forwarding it
  // verbatim makes the endpoint answer 400 "paymentChallenge required".
  it("parses a paymentChallenge that arrives as a JSON string", async () => {
    safeFetch.mockResolvedValue(jsonResponse(200, { signature: "0xdeadbeef" }));

    const result = await signPaymentStep({
      ...baseInput,
      paymentChallenge: JSON.stringify(CHALLENGE),
    });

    expect(result).toEqual({
      success: true,
      status: "signed",
      signature: "0xdeadbeef",
    });
    expect(sentBody().paymentChallenge).toEqual(CHALLENGE);
  });

  it("forwards workflowSlug on every request", async () => {
    safeFetch.mockResolvedValue(jsonResponse(200, { signature: "0xdeadbeef" }));

    await signPaymentStep(baseInput);

    expect(sentBody()).toMatchObject({
      chain: "base",
      workflowSlug: "my-workflow",
    });
  });

  it("rejects malformed JSON in paymentChallenge with a parse error", async () => {
    const result = await signPaymentStep({
      ...baseInput,
      paymentChallenge: "{ not json",
    });

    expect(result).toMatchObject({
      success: false,
      status: "error",
      error: expect.stringContaining("paymentChallenge is not valid JSON"),
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("rejects a paymentChallenge that is not an object", async () => {
    const result = await signPaymentStep({
      ...baseInput,
      paymentChallenge: JSON.stringify(["not", "an", "object"]),
    });

    expect(result).toMatchObject({
      success: false,
      status: "error",
      error: "paymentChallenge must be a JSON object",
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses to call out when the connection holds only half the pair", async () => {
    mockFetchCredentials.mockResolvedValue({
      AGENT_GATEWAY_HMAC_SECRET: "test-secret",
    });

    const result = await signPaymentStep(baseInput);

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
