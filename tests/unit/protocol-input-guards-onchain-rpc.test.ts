import { beforeEach, describe, expect, it, vi } from "vitest";

// Unlike protocol-input-guards-onchain.test.ts, readContractCore is NOT mocked
// here. Which provider the ownerOf read uses is decided inside it, from the
// _context the guard passes, so a test that mocks it can only see the guard
// forwarding its own input. This one lets the real readContractCore and the
// real RPC-preference lookup run, and asserts what reaches the provider
// factory.

vi.mock("server-only", () => ({}));

const {
  DIRECT_EXECUTION_ID,
  EXECUTION_USER,
  WORKFLOW_EXECUTION_ID,
  mockGetRpcProvider,
  mockResolveSignerForNode,
} = vi.hoisted(() => ({
  DIRECT_EXECUTION_ID: "direct_exec_1",
  EXECUTION_USER: "user_exec_42",
  WORKFLOW_EXECUTION_ID: "wf_exec_1",
  mockGetRpcProvider: vi.fn(),
  mockResolveSignerForNode: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    NETWORK_RPC: "network_rpc",
    VALIDATION: "validation",
  },
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
}));

// Keyed on table and id: only a workflowExecutions row for the workflow run
// carries a user. The table is recognised by a tableName the schema mock below
// supplies itself - real drizzle tables carry their name on a symbol. A
// directExecutions id - what /api/execute/node passes - finds nothing there,
// which is what puts that read on the chain default. A mock answering every id
// would hide that.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: { tableName?: string }) => ({
        where: (condition: { value?: unknown }) => ({
          limit: () =>
            Promise.resolve(
              table.tableName === "workflow_executions" &&
                condition.value === WORKFLOW_EXECUTION_ID
                ? [{ userId: EXECUTION_USER }]
                : []
            ),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {
    tableName: "workflow_executions",
    id: "id",
    userId: "userId",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: unknown) => ({ value }),
  sql: () => ({}),
}));

vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "",
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: () => 1,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: mockGetRpcProvider,
  isSolanaChain: () => false,
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: mockResolveSignerForNode,
}));

import { checkProtocolOnchainGuards } from "@/lib/protocol-input-guards-onchain";
import { registerProtocol } from "@/lib/protocol-registry";
import uniswapDef from "@/protocols/uniswap-v3";

registerProtocol(uniswapDef);

const increase = (executionId: string | undefined) =>
  checkProtocolOnchainGuards({
    protocolSlug: "uniswap",
    functionName: "increaseLiquidity",
    inputs: { tokenId: "180205" },
    network: "1",
    organizationId: "org_1",
    executionId,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  });
  // Stop at provider selection: everything this file asserts has happened by
  // then, and a rejected provider is a read failure the guard passes on.
  mockGetRpcProvider.mockRejectedValue(new Error("stop after selection"));
});

describe("increase-liquidity ownership guard RPC selection", () => {
  // The workflow write resolves the execution's user and honours their RPC
  // preference. The guard's read has to land on the same provider, or it fails
  // open for exactly the users whose custom RPC exists because the default
  // does not work for them.
  it("reads through the execution user's RPC preference on the workflow path", async () => {
    await increase(WORKFLOW_EXECUTION_ID);

    expect(mockGetRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1, userId: EXECUTION_USER })
    );
  });

  // /api/execute/node always creates a directExecutions row and passes its id.
  // The preference lookup reads workflowExecutions only, so it misses and the
  // read uses the chain default. If the lookup ever learns to resolve direct
  // executions, this fails and says so.
  it("uses the chain default for a direct execution id", async () => {
    await increase(DIRECT_EXECUTION_ID);

    expect(mockGetRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1, userId: undefined })
    );
  });

  // /api/execute/{protocol}/{action} runs the guard before reservation, so
  // there is no execution id at all, and its write passes organizationId,
  // which also resolves the chain default.
  it("uses the chain default when there is no execution", async () => {
    await increase(undefined);

    expect(mockGetRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1, userId: undefined })
    );
  });
});
