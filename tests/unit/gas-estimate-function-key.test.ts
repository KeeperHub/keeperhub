import { ethers } from "ethers";
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
vi.mock("@/lib/safe/signer-resolver", () => ({
  resolveSignerForNode: vi.fn(),
  SIGNER_MODE: { EOA: "eoa" },
}));
vi.mock("@/plugins/web3/steps/batch-write-contract-core", () => ({
  buildCallsWithMeta: vi.fn(),
}));
const estimateGas = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn().mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn({ estimateGas }),
  }),
}));

import { POST } from "@/app/api/gas/estimate/route";

const ADDRESS = "0x2222222222222222222222222222222222222222";
const tuple = {
  name: "send",
  type: "function",
  inputs: [
    { name: "p", type: "tuple", components: [{ name: "n", type: "uint256" }] },
  ],
};
const scalar = {
  name: "send",
  type: "function",
  inputs: [{ name: "n", type: "uint256" }],
};

function estimate(
  abi: unknown[],
  abiFunction: string,
  args: unknown[] = [[7]]
) {
  return POST(
    new Request("http://localhost/api/gas/estimate", {
      method: "POST",
      body: JSON.stringify({
        chainId: 1,
        actionSlug: "write-contract",
        config: {
          contractAddress: ADDRESS,
          abi: JSON.stringify(abi),
          abiFunction,
          functionArgs: JSON.stringify(args),
        },
      }),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  estimateGas.mockResolvedValue(BigInt(45_000));
});

describe("gas estimate function keys", () => {
  it.each(["send(tuple)", "send((uint256))"])(
    "N2 estimates %s using the actual ethers encoder",
    async (key) => {
      const response = await estimate([tuple, scalar], key);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ estimatedGas: "45000" });
      expect(estimateGas).toHaveBeenCalledWith(
        expect.objectContaining({
          data: new ethers.Interface([tuple, scalar]).encodeFunctionData(
            "send((uint256))",
            [[7]]
          ),
        })
      );
    }
  );
  it("preserves human-readable ABI entries accepted by ethers", async () => {
    const response = await estimate(
      ["function send((uint256 n) p)", scalar],
      "send(tuple)"
    );
    expect(response.status).toBe(200);
    expect(estimateGas).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous bare names without estimating an arbitrary overload", async () => {
    const response = await estimate([tuple, scalar], "send", [7]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("matches 2 overloads"),
    });
    expect(estimateGas).not.toHaveBeenCalled();
  });
  it("does not confuse duplicate canonical entries with overloads", async () => {
    const response = await estimate([tuple, tuple], "send");
    expect(response.status).toBe(200);
    expect(estimateGas).toHaveBeenCalledTimes(1);
  });
  it("distinguishes a malformed fragment from an absent function", async () => {
    const malformed = await estimate(
      [{ ...tuple, inputs: [{ name: "p", type: "tuple" }] }],
      "send(tuple)"
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: expect.stringContaining("Invalid ABI function"),
    });
    const absent = await estimate([tuple], "missing");
    expect(absent.status).toBe(400);
    expect(await absent.json()).toMatchObject({
      error: expect.stringContaining("not found in ABI"),
    });
    expect(estimateGas).not.toHaveBeenCalled();
  });
});
