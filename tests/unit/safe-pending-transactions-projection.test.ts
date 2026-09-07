import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    VALIDATION: "validation",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { getPendingTransactionsStep } from "@/plugins/safe/steps/get-pending-transactions";

const SAFE_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("Safe pending transaction projection", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    mockFetchCredentials.mockResolvedValue({ apiKey: "test-api-key" });
    safeFetch.mockReset();
  });

  it("preserves every execTransaction gas and refund field", async () => {
    safeFetch
      .mockResolvedValueOnce(jsonResponse({ nonce: 7 }))
      .mockResolvedValueOnce(
        jsonResponse({
          count: 1,
          results: [
            {
              safe: SAFE_ADDRESS,
              to: "0x0000000000000000000000000000000000000001",
              value: "42",
              data: "0x1234",
              operation: 0,
              nonce: 7,
              safeTxHash: `0x${"ab".repeat(32)}`,
              submissionDate: "2026-09-07T19:00:00Z",
              executionDate: null,
              isExecuted: false,
              confirmationsRequired: 2,
              confirmations: [],
              dataDecoded: null,
              safeTxGas: 123,
              baseGas: 456,
              gasPrice: "789",
              gasToken: "0x0000000000000000000000000000000000000002",
              refundReceiver: "0x0000000000000000000000000000000000000003",
              origin: null,
            },
          ],
        })
      );

    const result = await getPendingTransactionsStep({
      integrationId: "int-safe",
      safeAddress: SAFE_ADDRESS,
      network: "ethereum",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      safeTxGas: 123,
      baseGas: 456,
      gasPrice: "789",
      gasToken: "0x0000000000000000000000000000000000000002",
      refundReceiver: "0x0000000000000000000000000000000000000003",
    });
  });
});
