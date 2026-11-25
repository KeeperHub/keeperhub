import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveOrganizationId: vi.fn().mockResolvedValue({
    organizationId: "org-1",
    authMethod: "oauth",
    apiKeyId: null,
    scope: "mcp:read",
  }),
}));
vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi
    .fn()
    .mockResolvedValue("0x1111111111111111111111111111111111111111"),
}));
const estimateGas = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(),
}));

import { POST } from "@/app/api/gas/estimate/route";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { PrivateRelayUnavailableError } from "@/lib/rpc/providers";

function estimate(actionSlug: string, config: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/gas/estimate", {
      method: "POST",
      body: JSON.stringify({ chainId: 1, actionSlug, config }),
    })
  );
}

const TRANSFER = {
  recipientAddress: "0x2222222222222222222222222222222222222222",
  amount: "1",
};

beforeEach(() => {
  vi.mocked(getRpcProvider).mockReset();
  vi.mocked(getRpcProvider).mockResolvedValue({
    hasPrivateRelayPrimary: () => true,
    assertPrivateRelayChain: () => Promise.resolve(),
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn({ estimateGas }),
  } as never);
  estimateGas.mockResolvedValue(BigInt(21_000));
});

describe("editor gas estimate and Send as", () => {
  it("estimates through the relay when Send as is Private relay", async () => {
    const response = await estimate("transfer-funds", {
      ...TRANSFER,
      sendMode: "private-relay",
    });
    expect(response.status).toBe(200);
    expect(vi.mocked(getRpcProvider).mock.calls[0]?.[0]).toMatchObject({
      usePrivateMempool: true,
    });
  });

  it("uses the regular RPC for a normal send", async () => {
    await estimate("transfer-funds", TRANSFER);
    expect(vi.mocked(getRpcProvider).mock.calls[0]?.[0]).toMatchObject({
      usePrivateMempool: false,
    });
  });

  it("says why when the network has no relay", async () => {
    vi.mocked(getRpcProvider).mockRejectedValue(
      new PrivateRelayUnavailableError("no relay here")
    );
    const response = await estimate("transfer-funds", {
      ...TRANSFER,
      usePrivateMempool: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "no relay here" });
  });

  it("refuses the relay on Batch Write Contract without any RPC", async () => {
    const response = await estimate("batch-write-contract", {
      calls: "[]",
      sendMode: "private-relay",
    });
    expect(response.status).toBe(400);
    expect(getRpcProvider).not.toHaveBeenCalled();
  });
});
