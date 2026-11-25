import { beforeEach, describe, expect, it, vi } from "vitest";

// Unlike protocol-input-guards-onchain.test.ts, readContractCore is NOT mocked
// here. Which route the ownerOf read takes is decided inside it, from the
// _context and selection the guard passes, so this lets the real
// readContractCore run and asserts what reaches the RPC engine.

vi.mock("server-only", () => ({}));

const { mockRpcEvm, mockResolveSignerForNode } = vi.hoisted(() => ({
  mockRpcEvm: vi.fn(),
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

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "",
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: () => 1,
}));

vi.mock("@/lib/rpc/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rpc/engine")>()),
  rpc: { evm: mockRpcEvm, solana: vi.fn(), route: vi.fn() },
}));

// SIGNER_MODE comes through real so the guard compares against the enum it
// imports, not a copy this file wrote.
vi.mock("@/lib/safe/signer-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe/signer-resolver")>()),
  resolveSignerForNode: mockResolveSignerForNode,
}));

import { checkProtocolOnchainGuards } from "@/lib/protocol-input-guards-onchain";
import { registerProtocol } from "@/lib/protocol-registry";
import {
  RPC_SELECTION_CONFIG_KEY,
  RpcPurpose,
  RpcScopeKind,
  type RpcSelection,
  RpcSelectionMode,
} from "@/lib/rpc/engine";
import { SIGNER_MODE } from "@/lib/safe/signer-resolver";
import uniswapDef from "@/protocols/uniswap-v3";

registerProtocol(uniswapDef);

const ORG_ID = "org_1";
const EXECUTION_ID = "wf_exec_1";
const CONFIG_ID = "rpc_config_1";
const CHAIN_ID = 1;

const increase = (
  executionId: string | undefined,
  selection?: string
): ReturnType<typeof checkProtocolOnchainGuards> =>
  checkProtocolOnchainGuards({
    protocolSlug: "uniswap",
    functionName: "increaseLiquidity",
    inputs: { tokenId: "180205" },
    network: String(CHAIN_ID),
    organizationId: ORG_ID,
    executionId,
    [RPC_SELECTION_CONFIG_KEY]: selection,
  });

function expectReadRoutedWith(
  selection: RpcSelection,
  executionId: string | undefined
): void {
  expect(mockRpcEvm).toHaveBeenCalledTimes(1);
  expect(mockRpcEvm).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: RpcScopeKind.ORG,
      organizationId: ORG_ID,
      executionId,
      selection,
    }),
    CHAIN_ID,
    { purpose: RpcPurpose.READ }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSignerForNode.mockResolvedValue({
    kind: SIGNER_MODE.EOA,
    ownerAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  });
  // Stop at route resolution: everything this file asserts has happened by
  // then, and a failed read is one the guard refuses on.
  mockRpcEvm.mockRejectedValue(new Error("stop after selection"));
});

describe("increase-liquidity ownership guard RPC selection", () => {
  it("reads through the write's organization and pinned RPC config", async () => {
    const result = await increase(EXECUTION_ID, CONFIG_ID);

    expect(result.ok).toBe(false);
    expectReadRoutedWith(
      { mode: RpcSelectionMode.CONFIG, configId: CONFIG_ID },
      EXECUTION_ID
    );
  });

  it("keeps a KeeperHub selection on the read", async () => {
    await increase(EXECUTION_ID, RpcSelectionMode.PLATFORM);

    expectReadRoutedWith({ mode: RpcSelectionMode.PLATFORM }, EXECUTION_ID);
  });

  it("follows the organization's default route when the write names none", async () => {
    await increase(EXECUTION_ID);

    expectReadRoutedWith({ mode: RpcSelectionMode.AUTO }, EXECUTION_ID);
  });

  // /api/execute/{protocol}/{action} runs the guard before reservation, so
  // there is no execution id; the organization still decides the route.
  it("uses the organization's route when there is no execution", async () => {
    await increase(undefined, CONFIG_ID);

    expectReadRoutedWith(
      { mode: RpcSelectionMode.CONFIG, configId: CONFIG_ID },
      undefined
    );
  });
});
