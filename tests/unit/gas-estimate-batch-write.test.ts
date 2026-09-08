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

vi.mock("@/lib/mcp/oauth-scopes", () => ({
  SCOPE_MCP_READ: "mcp:read",
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi
    .fn()
    .mockResolvedValue("0xwalletaddress1234567890123456789012345678"),
}));

const mockEstimateGas = vi.fn();
vi.mock("@/lib/contracts/multicall3", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  MULTICALL3_ABI: [
    { name: "aggregate3", type: "function", inputs: [], outputs: [] },
  ],
}));

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        aggregate3 = { estimateGas: mockEstimateGas };
      },
    },
  };
});

const mockBuildCallsWithMeta = vi.fn();
vi.mock("@/plugins/web3/steps/batch-write-contract-core", () => ({
  // Mocked at the module boundary (mirrors batch-write-contract-core.ts's
  // own extensive mocking in tests/unit/batch-write-contract.test.ts): the
  // real module transitively imports db/wallet-helpers/chain-adapter/etc,
  // none of which are available in this route-focused test. The
  // isolateCallFailures resolution below is a direct copy of
  // resolveIsolateCallFailures's own one-liner (already covered by
  // dedicated tests elsewhere), so the allowFailure-threading tests here
  // assert on real derived output, not a hand-picked mock return.
  buildCallsWithMeta: (...args: unknown[]) => mockBuildCallsWithMeta(...args),
}));

const mockGetRpcProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

const mockResolveSignerForNode = vi.fn();
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: (...args: unknown[]) =>
    mockResolveSignerForNode(...args),
}));

import { POST } from "@/app/api/gas/estimate/route";

const WORK_ABI = JSON.stringify([
  {
    type: "function",
    name: "work",
    stateMutability: "nonpayable",
    inputs: [
      { name: "network", type: "bytes32" },
      { name: "args", type: "bytes" },
    ],
    outputs: [],
  },
]);

const JOB_1 = "0x1111111111111111111111111111111111111111";
const NETWORK_BYTES32 = `0x${"11".repeat(32)}`;
const ARGS_BYTES = "0xabcd1234";

const SAMPLE_CALLS = [
  {
    contractAddress: JOB_1,
    abi: WORK_ABI,
    abiFunction: "work",
    args: [NETWORK_BYTES32, ARGS_BYTES],
  },
];

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/gas/estimate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function resolveAllowFailure(isolateCallFailures: unknown): boolean {
  return isolateCallFailures !== false && isolateCallFailures !== "false";
}

function defaultBuildCallsWithMeta(input: {
  isolateCallFailures?: string | boolean;
}) {
  return {
    calls: [
      {
        target: JOB_1,
        allowFailure: resolveAllowFailure(input.isolateCallFailures),
        callData: "0xdeadbeef",
      },
    ],
  };
}

function callFailureFlags(): boolean[] {
  const call3Array = mockEstimateGas.mock.calls[0][0] as {
    allowFailure: boolean;
  }[];
  return call3Array.map((c) => c.allowFailure);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) => fn({}),
  });
  mockBuildCallsWithMeta.mockImplementation(defaultBuildCallsWithMeta);
  mockEstimateGas.mockResolvedValue(BigInt(150_000));
  mockResolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xwalletaddress1234567890123456789012345678",
  });
});

describe("POST /api/gas/estimate - batch-write-contract", () => {
  it("estimates gas for a valid batch-write-contract config", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          calls: JSON.stringify(SAMPLE_CALLS),
        },
      })
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { estimatedGas: string };
    expect(data.estimatedGas).toBe("150000");
    expect(mockBuildCallsWithMeta).toHaveBeenCalledWith({
      calls: JSON.stringify(SAMPLE_CALLS),
      isolateCallFailures: undefined,
    });
    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
    expect(mockEstimateGas).toHaveBeenCalledWith(
      [{ target: JOB_1, allowFailure: true, callData: "0xdeadbeef" }],
      { from: "0xwalletaddress1234567890123456789012345678" }
    );
  });

  it("derives allowFailure=true when isolateCallFailures is absent, matching the step's default", async () => {
    await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: { calls: JSON.stringify(SAMPLE_CALLS) },
      })
    );

    expect(callFailureFlags()).toEqual([true]);
  });

  it('forwards string "false" to buildCallsWithMeta unchanged', async () => {
    // Asserts the route's own contract (it forwards the raw config value),
    // not the mock's resolution copy of resolveIsolateCallFailures, which
    // has its own dedicated coverage in batch-write-contract.test.ts. A test
    // reading callFailureFlags() here would still pass even if the route
    // forwarded the wrong value, since that helper reads back whatever this
    // file's own mock derived from it, not what the route actually sent.
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          calls: JSON.stringify(SAMPLE_CALLS),
          isolateCallFailures: "false",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockBuildCallsWithMeta).toHaveBeenCalledWith({
      calls: JSON.stringify(SAMPLE_CALLS),
      isolateCallFailures: "false",
    });
  });

  it("forwards native boolean false to buildCallsWithMeta unchanged", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          calls: JSON.stringify(SAMPLE_CALLS),
          isolateCallFailures: false,
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockBuildCallsWithMeta).toHaveBeenCalledWith({
      calls: JSON.stringify(SAMPLE_CALLS),
      isolateCallFailures: false,
    });
  });

  it("rejects when calls is missing", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {},
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("calls is required");
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  it("rejects a non-EOA signer mode instead of returning a plausible-looking estimate", async () => {
    // batchWriteContractCore hard-gates to EOA-only (Safe/Safe-Role would
    // change msg.sender for every batched call). Unlike write-contract,
    // which supports Safe/Safe-Role at broadcast, a batch estimate for a
    // Safe org is guaranteed to fail at execution, so it must not succeed
    // here either.
    mockResolveSignerForNode.mockResolvedValueOnce({
      kind: "safe",
      safeAddress: "0xsafe",
    });

    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: { calls: JSON.stringify(SAMPLE_CALLS) },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("EOA");
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  it("passes chainId and the node's web3Connection to resolveSignerForNode", async () => {
    await POST(
      makeRequest({
        chainId: 137,
        actionSlug: "batch-write-contract",
        config: {
          calls: JSON.stringify(SAMPLE_CALLS),
          web3Connection: "safe-connection-1",
        },
      })
    );

    expect(mockResolveSignerForNode).toHaveBeenCalledWith({
      organizationId: "org-1",
      chainId: 137,
      web3Connection: "safe-connection-1",
    });
  });

  it("propagates a buildCallsWithMeta error", async () => {
    mockBuildCallsWithMeta.mockReturnValueOnce({
      calls: [],
      error: "Call at index 0 missing abi",
    });

    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          calls: JSON.stringify([
            { contractAddress: JOB_1, abiFunction: "work", args: [] },
          ]),
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Call at index 0 missing abi");
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  it("rejects template references in calls", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: { calls: "{{@prep:Prep.calls}}" },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("template references");
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
  });

  it("rejects a native calls array containing a template reference in an arg", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          calls: [
            {
              contractAddress: JOB_1,
              abi: WORK_ABI,
              abiFunction: "work",
              args: ["{{@prep:Prep.arg}}"],
            },
          ],
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("template references");
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
  });

  it("rejects a native calls array containing a template reference in contractAddress", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          calls: [
            {
              contractAddress: "{{@prep:Prep.target}}",
              abi: WORK_ABI,
              abiFunction: "work",
              args: [],
            },
          ],
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("template references");
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
  });

  it("rejects an unresolved template reference in isolateCallFailures", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          calls: JSON.stringify(SAMPLE_CALLS),
          isolateCallFailures: "{{@prep:Prep.isolate}}",
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("template references");
    expect(mockBuildCallsWithMeta).not.toHaveBeenCalled();
  });

  it("accepts calls as a native array in the request body", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: { calls: SAMPLE_CALLS },
      })
    );

    expect(response.status).toBe(200);
    expect(mockBuildCallsWithMeta).toHaveBeenCalledWith({
      calls: SAMPLE_CALLS,
      isolateCallFailures: undefined,
    });
  });
});
