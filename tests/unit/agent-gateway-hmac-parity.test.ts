import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { computeSignature as canonicalComputeSignature } from "@/lib/agentic-wallet/hmac";
import { computeSignature as pluginComputeSignature } from "@/plugins/agent-gateway/steps/hmac-request-core";

describe("agent-gateway HMAC signature parity", () => {
  it("matches the canonical computeSignature for a fixed test vector", () => {
    const secret = "test-secret-key-12345";
    const method = "POST";
    const path = "/api/agentic-wallet/sign";
    const subOrgId = "sub-org-998877";
    const body = '{"workflowSlug":"uniswap-swap","chain":"base"}';
    const timestamp = "1725450000";

    const expectedSig =
      "492b16a179ae44acc6424ccb2bd7df505692ec99d5769db38309f23576694263";

    const canonicalSig = canonicalComputeSignature(
      secret,
      method,
      path,
      subOrgId,
      body,
      timestamp
    );
    const pluginSig = pluginComputeSignature(
      secret,
      method,
      path,
      subOrgId,
      body,
      timestamp
    );

    expect(canonicalSig).toBe(expectedSig);
    expect(pluginSig).toBe(expectedSig);
    expect(pluginSig).toBe(canonicalSig);
  });

  it("maintains exact parity across diverse methods, paths, and payloads", () => {
    const testCases = [
      {
        secret: "sec-alpha-1",
        method: "GET",
        path: "/api/agentic-wallet/credit",
        subOrgId: "org-xyz",
        body: "",
        timestamp: "1725450123",
      },
      {
        secret: "sec-beta-2",
        method: "POST",
        path: "/api/agentic-wallet/sign",
        subOrgId: "sub-123456",
        body: JSON.stringify({ amount: "100.50", payTo: "0x1234567890123456789012345678901234567890" }),
        timestamp: "1725450456",
      },
      {
        secret: "sec-gamma-3",
        method: "DELETE",
        path: "/api/agentic-wallet/link",
        subOrgId: "sub-999",
        body: '{"reason":"revoked"}',
        timestamp: "1725450789",
      },
      {
        secret: "sec-delta-4",
        method: "POST",
        path: "/api/agentic-wallet/sign",
        subOrgId: "sub-unicode",
        body: '{"challenge":"payment-non-ascii-char-test-challenge"}',
        timestamp: "1725450999",
      },
    ];

    for (const tc of testCases) {
      const canonical = canonicalComputeSignature(
        tc.secret,
        tc.method,
        tc.path,
        tc.subOrgId,
        tc.body,
        tc.timestamp
      );
      const plugin = pluginComputeSignature(
        tc.secret,
        tc.method,
        tc.path,
        tc.subOrgId,
        tc.body,
        tc.timestamp
      );
      expect(plugin).toBe(canonical);
    }
  });
});
