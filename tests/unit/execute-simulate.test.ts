/**
 * Unit tests for lib/execute/simulate.ts.
 *
 * The simulate helpers route every chain call through
 * rpcManager.executeWithFailover (so a primary-RPC blip falls over to
 * the chain's fallback). These tests mock that boundary and assert:
 *
 *   - happy path: gas + decoded return value come back serialised
 *   - revert path: provider throws -> decoded reason in revertReason
 *   - empty-wallet path: a revert-data-less estimateGas failure is
 *     attributed to the funding address with code "insufficient_balance",
 *     and is NOT claimed when the balance covers the value or cannot be read
 *   - input-validation paths short-circuit before any RPC call
 *   - simulateTokenTransfer resolves the token address via
 *     parseTokenAddress (same helper the broadcast path uses) and
 *     fetches on-chain decimals when not provided
 *
 * Run with: pnpm vitest tests/unit/execute-simulate.test.ts
 */

import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const FROM_ADDRESS = "0xaa0000000000000000000000000000000000aa00";
const CONTRACT_ADDRESS = "0xbb0000000000000000000000000000000000bb00";
const RECIPIENT_ADDRESS = "0xcc0000000000000000000000000000000000cc00";

// Hoisted spies so the vi.mock factories below can reference them.
const rpcSpies = vi.hoisted(() => ({
  executeWithFailover: vi.fn(),
  getChainIdFromNetwork: vi.fn(),
  getOrganizationWalletAddress: vi.fn(),
  getRpcProvider: vi.fn(),
  isSolanaChain: vi.fn(),
  parseTokenAddress: vi.fn(),
  chainsLookup: vi.fn(() => Promise.resolve([{ symbol: "ETH" }])),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: rpcSpies.getOrganizationWalletAddress,
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: rpcSpies.getChainIdFromNetwork,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: rpcSpies.getRpcProvider,
  isSolanaChain: rpcSpies.isSolanaChain,
}));

vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  parseTokenAddress: rpcSpies.parseTokenAddress,
}));

vi.mock("@/lib/logging", () => ({
  logSystemError: vi.fn(),
  ErrorCategory: { DATABASE: "database" },
}));

// getNativeSymbol reads the chain's symbol from the seeded `chains` table.
// Only the insufficient-balance path touches it, and only for wording.
// Routed through a spy so a test can make the lookup reject and pin the
// documented degradation ("native") instead of a thrown error.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => rpcSpies.chainsLookup(),
        }),
      }),
    }),
  },
}));

// Coupling note: this stub exports only `chains`, which is every table the
// module graph under test currently reads (wallet-helpers and
// transfer-token-core are themselves mocked above, so the real schema never
// loads). If native-balance.ts ever reads a second table, Vitest fails this
// file with "No X export is defined on the mock" — add the table here.
vi.mock("@/lib/db/schema", () => ({
  chains: { chainId: "chain_id", symbol: "symbol" },
}));

// Import after mocks so the simulate module binds to the stubbed deps.
import {
  simulateContractCall,
  simulateNativeTransfer,
  simulateTokenTransfer,
} from "@/lib/execute/simulate";

const {
  executeWithFailover,
  getChainIdFromNetwork,
  getOrganizationWalletAddress,
  getRpcProvider,
  isSolanaChain,
  parseTokenAddress,
} = rpcSpies;

// Minimal ABI for a read with one address arg returning uint256.
const READ_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
]);

// Minimal ABI for a write with no return value (e.g. setValue(uint256)).
const WRITE_ABI = JSON.stringify([
  {
    type: "function",
    name: "setValue",
    inputs: [{ name: "value", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

function resetSpies(): void {
  vi.clearAllMocks();
  getChainIdFromNetwork.mockReturnValue(1);
  getOrganizationWalletAddress.mockResolvedValue(FROM_ADDRESS);
  getRpcProvider.mockResolvedValue({ executeWithFailover });
  isSolanaChain.mockReturnValue(false);
}

describe("simulateContractCall", () => {
  it("returns gas + decoded return value when the call succeeds", async () => {
    resetSpies();
    // ABI-encoded uint256(123)
    const encoded123 =
      "0x000000000000000000000000000000000000000000000000000000000000007b";
    executeWithFailover.mockResolvedValueOnce([BigInt(45_000), encoded123]);

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: READ_ABI,
      functionName: "balanceOf",
      functionArgs: JSON.stringify([FROM_ADDRESS]),
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("simulated");
    expect(result.from).toBe(FROM_ADDRESS);
    expect(result.to).toBe(CONTRACT_ADDRESS);
    expect(result.wouldRevert).toBe(false);
    if (result.success) {
      expect(result.gasEstimate).toBe("45000");
      expect(result.simulatedReturnValue).toBe("123");
    }
    // Failover wrapper is used, not provider.call directly.
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "preflight"
    );
  });

  it("returns wouldRevert with a decoded reason when failover rejects", async () => {
    resetSpies();
    // Build a CALL_EXCEPTION-shaped error carrying a standard
    // Error(string) revert. Selector + ABI-encoded reason.
    const errorSelector = "0x08c379a0";
    const encodedReason = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string"],
      ["Insufficient balance"]
    );
    const revertError = { data: errorSelector + encodedReason.slice(2) };
    executeWithFailover.mockRejectedValueOnce(revertError);

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify(["999"]),
    });

    expect(result.success).toBe(false);
    expect(result.wouldRevert).toBe(true);
    if (!result.success && result.failureKind !== "unavailable") {
      expect(result.failureKind).toBe("revert");
      expect(result.revertReason).toContain("Insufficient balance");
      expect(result.error).toBe(result.revertReason);
    }
  });

  it("returns unavailable instead of claiming an RPC outage would revert", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(
      new Error(
        "RPC failed on both endpoints. Primary: timeout. Fallback: timeout"
      )
    );

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify(["1"]),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain("Simulation unavailable");
      expect("revertReason" in result).toBe(false);
    }
  });

  it("attributes an undecodable failure on a value-bearing call to an empty wallet", async () => {
    resetSpies();
    // No revert data to decode, and the wallet cannot cover the 1 ETH value.
    executeWithFailover.mockRejectedValueOnce(
      new Error('missing revert data (action="estimateGas")')
    );
    executeWithFailover.mockResolvedValueOnce(ethers.parseEther("0.25"));

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify(["1"]),
      value: "1.0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("insufficient_balance");
      expect(result.shortfallWei).toBe(ethers.parseEther("0.75").toString());
      expect(result.revertReason).toContain("Have: 0.25, Need: 1.0");
      // Attribution adds, it does not replace: the node's own message
      // survives even when the shortfall claim takes over revertReason.
      expect(result.originalError).toContain("missing revert data");
      // The node returned no revert data here, so there is none to keep.
      expect(result.undecodedRevertData).toBeUndefined();
    }
  });

  it("keeps undecodable revert data alongside the shortfall claim", async () => {
    resetSpies();
    // Revert data the decode path cannot touch: the selector is not in the
    // supplied ABI, not in the common-errors list, and not Error(string).
    // The wallet is short too, so both facts are true at once.
    const undecodable = `0x1234abcd${"00".repeat(32)}`;
    executeWithFailover.mockRejectedValueOnce({
      data: undecodable,
      message: "execution reverted (unknown custom error)",
    });
    executeWithFailover.mockResolvedValueOnce(ethers.parseEther("0.25"));

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify(["1"]),
      value: "1.0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // The shortfall is real, so it is still reported...
      expect(result.code).toBe("insufficient_balance");
      expect(result.shortfallWei).toBe(ethers.parseEther("0.75").toString());
      // ...but the harder half to rediscover is kept: raw data for a
      // selector lookup, the selector named in the message, the node's
      // wording verbatim, and a warning that funding may not be the fix.
      expect(result.undecodedRevertData).toBe(undecodable);
      expect(result.revertReason).toContain("0x1234abcd");
      expect(result.revertReason).toContain("funding alone may not");
      expect(result.originalError).toBe(
        "execution reverted (unknown custom error)"
      );
    }
  });

  it("reports a chain-agnostic symbol when the chains lookup fails", async () => {
    resetSpies();
    rpcSpies.chainsLookup.mockRejectedValueOnce(new Error("db unavailable"));
    executeWithFailover.mockRejectedValueOnce(
      new Error('missing revert data (action="estimateGas")')
    );
    executeWithFailover.mockResolvedValueOnce(BigInt(0));

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify(["1"]),
      value: "1.0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // A DB blip degrades the wording; it must not replace the real
      // failure with a database error of its own.
      expect(result.code).toBe("insufficient_balance");
      expect(result.nativeSymbol).toBe("native");
      expect(result.revertReason).toContain("Insufficient native balance");
    }
  });

  it("returns wouldRevert when the ABI is not valid JSON", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: "not json",
      functionName: "setValue",
    });
    expect(result.success).toBe(false);
    expect(result.wouldRevert).toBe(true);
    if (!result.success) {
      expect(result.revertReason).toContain("ABI is not valid JSON");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionName is not in the ABI", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "nope",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("Function nope not found in ABI");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionArgs is not valid JSON", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: "not json",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("functionArgs is not valid JSON");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionArgs is not a JSON array", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify({ foo: "bar" }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain(
        "functionArgs must be a JSON array"
      );
    }
  });

  it("returns wouldRevert when value is not a valid ether amount", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      value: "not-a-number",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("Invalid value");
    }
  });

  it("returns validation when the selected network is invalid", async () => {
    resetSpies();
    getChainIdFromNetwork.mockImplementationOnce(() => {
      throw new Error("Unknown network: invalid-chain");
    });

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "invalid-chain",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: '["1"]',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("validation");
      expect(result.error).toContain("Unknown network");
    }
    expect(getRpcProvider).not.toHaveBeenCalled();
  });

  it("returns unavailable instead of rejecting when wallet resolution fails", async () => {
    resetSpies();
    getOrganizationWalletAddress.mockRejectedValueOnce(
      new Error("wallet database unavailable")
    );

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: '["1"]',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain("organization wallet");
    }
    expect(getRpcProvider).not.toHaveBeenCalled();
  });

  it("returns unavailable instead of rejecting when provider setup fails", async () => {
    resetSpies();
    getRpcProvider.mockRejectedValueOnce(new Error("provider config missing"));

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: '["1"]',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain("provider initialization");
    }
  });
});

describe("simulateNativeTransfer", () => {
  it("returns gas estimate when the network accepts the transfer", async () => {
    resetSpies();
    // EOA recipient: estimateGas returns 21000, provider.call returns
    // "0x" (no return data), so simulatedReturnValue ends up null.
    executeWithFailover.mockResolvedValueOnce([BigInt(21_000), "0x"]);

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.5",
    });

    expect(result.success).toBe(true);
    expect(result.wouldRevert).toBe(false);
    if (result.success) {
      expect(result.gasEstimate).toBe("21000");
      expect(result.from).toBe(FROM_ADDRESS);
      expect(result.to).toBe(RECIPIENT_ADDRESS);
      expect(result.simulatedReturnValue).toBeNull();
    }
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "preflight"
    );
  });

  it("surfaces return data when the recipient is a contract or precompile", async () => {
    resetSpies();
    // 32 bytes of zeros — what a SHA-256 precompile of empty input
    // would return.
    const precompileReturn = `0x${"00".repeat(32)}`;
    executeWithFailover.mockResolvedValueOnce([
      BigInt(24_338),
      precompileReturn,
    ]);

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.000005",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.gasEstimate).toBe("24338");
      expect(result.simulatedReturnValue).toBe(precompileReturn);
    }
  });

  it("returns wouldRevert when estimateGas throws", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(
      new Error("insufficient funds for gas * price + value")
    );
    // Balance covers the value, so the node's own message is the truthful
    // answer and must not be replaced by a shortfall claim.
    executeWithFailover.mockResolvedValueOnce(ethers.parseEther("10"));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.5",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain("insufficient funds");
      expect(result.code).toBeUndefined();
    }
  });

  it("attributes a revert-data-less estimateGas failure to an empty wallet", async () => {
    resetSpies();
    // What Base (and most nodes) return when `from` cannot cover the value:
    // an error with no revert data, which ethers surfaces as a bare
    // CALL_EXCEPTION naming neither the balance nor the address.
    executeWithFailover.mockRejectedValueOnce(
      new Error(
        'missing revert data (action="estimateGas", data=null, reason=null, code=CALL_EXCEPTION, version=6.16.0)'
      )
    );
    executeWithFailover.mockResolvedValueOnce(BigInt(0));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.001",
    });

    expect(result.success).toBe(false);
    expect(result.wouldRevert).toBe(true);
    if (!result.success) {
      expect(result.code).toBe("insufficient_balance");
      expect(result.balanceWei).toBe("0");
      expect(result.requiredWei).toBe(ethers.parseEther("0.001").toString());
      expect(result.shortfallWei).toBe(ethers.parseEther("0.001").toString());
      expect(result.nativeSymbol).toBe("ETH");
      // The message has to carry the two facts the caller cannot look up:
      // which address to fund, and by how much.
      expect(result.revertReason).toContain(FROM_ADDRESS);
      expect(result.revertReason).toContain("Have: 0.0, Need: 0.001");
      expect(result.revertReason).toContain("at least 0.001 ETH");
      expect(result.error).toBe(result.revertReason);
      // The node's message is kept even though the shortfall claim is the
      // one surfaced in revertReason.
      expect(result.originalError).toContain("missing revert data");
    }
    // One estimateGas/call round trip, then exactly one balance read.
    expect(executeWithFailover).toHaveBeenCalledTimes(2);
  });

  it("decodes a reverting contract recipient without a supplied ABI", async () => {
    resetSpies();
    // A native send can hit a contract that reverts with Error(string).
    // There is no ABI on this path, but the standard selector still decodes.
    const encodedReason = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string"],
      ["recipient rejects ETH"]
    );
    executeWithFailover.mockRejectedValueOnce({
      data: `0x08c379a0${encodedReason.slice(2)}`,
    });

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.001",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("recipient rejects ETH");
      expect(result.code).toBeUndefined();
      // Decoding wins the revertReason, but the node's message is still kept.
      // Before the shared helper, this path returned the raw message as the
      // whole reason, so discarding it here would lose information.
      expect(result.originalError).toBeDefined();
    }
    // A decoded reason is the specific answer: no balance read is spent.
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("keeps a native send's undecodable revert data when the wallet is short", async () => {
    resetSpies();
    const undecodable = `0x9abcdef0${"11".repeat(32)}`;
    executeWithFailover.mockRejectedValueOnce({
      data: undecodable,
      message: "execution reverted",
    });
    executeWithFailover.mockResolvedValueOnce(BigInt(0));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.001",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("insufficient_balance");
      expect(result.undecodedRevertData).toBe(undecodable);
      expect(result.revertReason).toContain("0x9abcdef0");
      expect(result.originalError).toBe("execution reverted");
    }
  });

  it("keeps the original error when the balance read itself fails", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(new Error("node exploded"));
    executeWithFailover.mockRejectedValueOnce(new Error("balance read failed"));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.001",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain("node exploded");
      expect(result.code).toBeUndefined();
    }
  });

  it("does not read the balance for a zero-value transfer", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(new Error("node exploded"));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.code).toBeUndefined();
    }
    // A zero-value call cannot be short of funds: no extra round trip.
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("rejects Solana as unsupported instead of attempting an EVM simulation", async () => {
    resetSpies();
    getChainIdFromNetwork.mockReturnValueOnce(101);
    isSolanaChain.mockReturnValueOnce(true);

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "101",
      recipientAddress: "11111111111111111111111111111111",
      amount: "1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("validation");
      expect(result.error).toContain("EVM networks only");
    }
    expect(getOrganizationWalletAddress).toHaveBeenCalledTimes(1);
    expect(getRpcProvider).not.toHaveBeenCalled();
  });

  it("rejects a malformed amount before touching the network", async () => {
    resetSpies();
    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "potato",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.from).toBe(FROM_ADDRESS);
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });
});

describe("simulateTokenTransfer", () => {
  it("resolves the token via parseTokenAddress, fetches decimals on-chain, then simulates", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);
    // First failover call: decimals() returns uint8(6) (USDC).
    executeWithFailover.mockResolvedValueOnce(BigInt(6));
    // Second failover call: [estimateGas, returnData] for transfer.
    executeWithFailover.mockResolvedValueOnce([
      BigInt(65_000),
      // ABI-encoded bool(true)
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]);

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      // No tokenAddress; resolves via tokenConfig.
      tokenConfig: JSON.stringify({ supportedTokenId: "usdc-mainnet" }),
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "12.5",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe(CONTRACT_ADDRESS);
      expect(result.gasEstimate).toBe("65000");
      expect(result.simulatedReturnValue).toBe(true);
    }
    expect(parseTokenAddress).toHaveBeenCalledTimes(1);
    // decimals fetch + actual simulate = 2 failover invocations.
    expect(executeWithFailover).toHaveBeenCalledTimes(2);
    expect(executeWithFailover.mock.calls[0]?.[1]).toBe("preflight");
    expect(executeWithFailover.mock.calls[1]?.[1]).toBe("preflight");
  });

  it("skips the on-chain decimals lookup when decimals is provided", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);
    executeWithFailover.mockResolvedValueOnce([
      BigInt(65_000),
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]);

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenAddress: CONTRACT_ADDRESS,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "12.5",
      decimals: 6,
    });

    expect(result.success).toBe(true);
    // Only the simulate call, no decimals preflight.
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
    expect(executeWithFailover.mock.calls[0]?.[1]).toBe("preflight");
  });

  it("rejects when parseTokenAddress cannot resolve a token", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(null);

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenConfig: JSON.stringify({ mode: "popular" }),
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "100",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("resolvable");
    }
    // No RPC calls fire on a token-resolve failure.
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("returns unavailable instead of rejecting when token resolution fails", async () => {
    resetSpies();
    parseTokenAddress.mockRejectedValueOnce(
      new Error("token database unavailable")
    );

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenConfig: JSON.stringify({ supportedTokenId: "usdc-mainnet" }),
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "100",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain("token configuration");
    }
    expect(getOrganizationWalletAddress).toHaveBeenCalledTimes(1);
    expect(getRpcProvider).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when the decimals RPC is unavailable", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);
    executeWithFailover.mockRejectedValueOnce(new Error("RPC timeout"));

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenAddress: CONTRACT_ADDRESS,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "100",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("unavailable");
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain("Simulation unavailable");
    }
  });

  it("rejects invalid explicit token decimals before simulating", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenAddress: CONTRACT_ADDRESS,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "100",
      decimals: 256,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failureKind).toBe("validation");
      expect(result.error).toContain("Invalid token decimals");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("rejects an amount that can't be parsed at the resolved decimals", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);
    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenAddress: CONTRACT_ADDRESS,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "potato",
      decimals: 18,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("Invalid amount for 18 decimals");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });
});
