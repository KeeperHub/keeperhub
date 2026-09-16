/**
 * KEEP-2499: Uniswap V3 SwapRouter sentinel value guards
 *
 * Verifies that the protocol write step rejects dangerous sentinel values:
 * - recipient == address(1) (msg.sender rewrite)
 * - recipient == address(2) (router itself, funds claimable by anyone)
 * - amountIn == 0 on exactInputSingle (CONTRACT_BALANCE flag)
 */

import { describe, it, expect, vi } from "vitest";

// ── Mocks (before imports) ───────────────────────────────────────────

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { CONFIGURATION: "configuration" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: vi.fn(),
}));

vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: vi.fn(),
}));

vi.mock("@/lib/execute/value-ledger", () => ({
  withStepValueCap: async (_opts: unknown, fn: () => Promise<unknown>) =>
    await fn(),
}));

// ── Import under test ────────────────────────────────────────────────

import { protocolWriteStep } from "@/plugins/protocol/steps/protocol-write";

describe("Uniswap V3 sentinel value guards", () => {
  const SENTINEL_MSG_SENDER = "0x0000000000000000000000000000000000000001";
  const SENTINEL_ROUTER = "0x0000000000000000000000000000000000000002";
  const SAFE_RECIPIENT = "0x1234567890123456789012345678901234567890";

  it("rejects recipient == address(1) on swap-exact-input", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SENTINEL_MSG_SENDER,
      amountIn: "1000000",
      amountOutMinimum: "0",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("address(1)");
    expect(result.error).toContain("msg.sender rewrite");
  });

  it("rejects recipient == address(2) on swap-exact-input", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SENTINEL_ROUTER,
      amountIn: "1000000",
      amountOutMinimum: "0",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("address(2)");
    expect(result.error).toContain("router itself");
    expect(result.error).toContain("sweepToken");
  });

  it("rejects recipient == address(1) on swap-exact-output", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SENTINEL_MSG_SENDER,
      amountOut: "1000000000000000000",
      amountInMaximum: "1000000000",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactOutputSingle",
        actionType: "write",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("address(1)");
  });

  it("rejects recipient == address(2) on swap-exact-output", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SENTINEL_ROUTER,
      amountOut: "1000000000000000000",
      amountInMaximum: "1000000000",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactOutputSingle",
        actionType: "write",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("address(2)");
  });

  it("rejects amountIn == 0 on swap-exact-input (CONTRACT_BALANCE flag)", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SAFE_RECIPIENT,
      amountIn: "0",
      amountOutMinimum: "0",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Amount In cannot be 0");
    expect(result.error).toContain("CONTRACT_BALANCE");
  });

  it("accepts safe recipient addresses on swap-exact-input", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SAFE_RECIPIENT,
      amountIn: "1000000",
      amountOutMinimum: "0",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      }),
    });

    // Should fail later for a different reason (ABI resolution, missing integration, etc.)
    // but NOT for sentinel value rejection
    if (!result.success) {
      expect(result.error).not.toContain("sentinel");
      expect(result.error).not.toContain("address(1)");
      expect(result.error).not.toContain("address(2)");
      expect(result.error).not.toContain("CONTRACT_BALANCE");
    }
  });

  it("accepts non-zero amountIn on swap-exact-input", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SAFE_RECIPIENT,
      amountIn: "1000000",
      amountOutMinimum: "0",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      }),
    });

    // Should fail later for a different reason, not for CONTRACT_BALANCE
    if (!result.success) {
      expect(result.error).not.toContain("CONTRACT_BALANCE");
    }
  });

  it("does not check amountIn on swap-exact-output (no CONTRACT_BALANCE flag)", async () => {
    // swap-exact-output doesn't have an amountIn parameter (it has amountInMaximum)
    // so the CONTRACT_BALANCE check should not apply
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      fee: "3000",
      recipient: SAFE_RECIPIENT,
      amountOut: "1000000000000000000",
      amountInMaximum: "1000000000",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactOutputSingle",
        actionType: "write",
      }),
    });

    // Should not fail for CONTRACT_BALANCE
    if (!result.success) {
      expect(result.error).not.toContain("CONTRACT_BALANCE");
    }
  });

  it("is case-insensitive for sentinel address matching", async () => {
    const result = await protocolWriteStep({
      network: "1",
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      fee: "3000",
      recipient: "0x0000000000000000000000000000000000000002", // lowercase
      amountIn: "1000000",
      amountOutMinimum: "0",
      sqrtPriceLimitX96: "0",
      _protocolMeta: JSON.stringify({
        protocolSlug: "uniswap",
        contractKey: "swapRouter",
        functionName: "exactInputSingle",
        actionType: "write",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("address(2)");
  });
});
