import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "VALIDATION" },
  logUserError: vi.fn(),
}));

// Stub only the network call; keep the real assertUrlIsPublic so the public
// IP-literal URL below passes the SSRF pre-check deterministically.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch };
});

import { chainInfoStep } from "@/plugins/evm-chain/steps/chain-info";
import { erc20BalanceStep } from "@/plugins/evm-chain/steps/erc20-balance";
import { ethBalanceStep } from "@/plugins/evm-chain/steps/eth-balance";
import { toNative } from "@/plugins/evm-chain/steps/evm-rpc-core";
import { gasPriceStep } from "@/plugins/evm-chain/steps/gas-price";

const ADDRESS = `0x${"a".repeat(40)}`;
// 93.184.216.34 (example.com): public IP literal, no DNS needed.
const PUBLIC_URL = "http://93.184.216.34";

function rpcOk(result: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result }),
  };
}

describe("evm-chain toNative", () => {
  it("omits the decimal point for whole-number balances", () => {
    expect(toNative(`0x${(BigInt(10) ** BigInt(18)).toString(16)}`)).toBe("1");
    expect(
      toNative(`0x${(BigInt(123) * BigInt(10) ** BigInt(18)).toString(16)}`)
    ).toBe("123");
  });

  it("renders fractional balances without a stray space", () => {
    expect(toNative(`0x${(BigInt(10) ** BigInt(17)).toString(16)}`)).toBe(
      "0.1"
    );
    expect(toNative(`0x${(BigInt(10) ** BigInt(16)).toString(16)}`)).toBe(
      "0.01"
    );
    expect(
      toNative(
        `0x${(
          BigInt(15) * BigInt(10) ** BigInt(18) +
            BigInt(5) * BigInt(10) ** BigInt(16)
        ).toString(16)}`
      )
    ).toBe("15.05");
  });

  it("keeps wei precision and drops trailing zeros", () => {
    expect(toNative("0x1")).toBe("0.000000000000000001");
    // 1000 wei = 1e-15 native units: trailing zeros are dropped.
    expect(toNative("0x3e8")).toBe("0.000000000000001");
  });

  it("handles a zero balance", () => {
    expect(toNative("0x0")).toBe("0");
  });
});

describe("evm-chain steps", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a configuration error when no RPC URL is set", async () => {
    mockFetchCredentials.mockResolvedValue({});

    const result = await gasPriceStep({ integrationId: "int-1" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("EVM_CHAIN_RPC_URL is not configured");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid address without calling the network", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });

    const result = await ethBalanceStep({
      address: "not-an-address",
      integrationId: "int-1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("address must be a 20-byte hex address");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("surfaces a JSON-RPC error object instead of the raw body", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32_602, message: "invalid address: 0x123" },
        }),
    });

    const result = await ethBalanceStep({
      address: ADDRESS,
      integrationId: "int-1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("invalid address");
      expect(result.error).not.toContain("jsonrpc");
    }
  });

  it("surfaces an HTTP failure from the RPC endpoint", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });
    safeFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
    });

    const result = await gasPriceStep({ integrationId: "int-1" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("RPC endpoint returned HTTP 502");
    }
  });

  it("surfaces an aborted request as a structured error", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });
    safeFetch.mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      })
    );

    const result = await gasPriceStep({ integrationId: "int-1" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("aborted");
    }
  });

  it("returns the native balance for a valid response", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });
    safeFetch.mockResolvedValue(rpcOk("0x7b"));

    const result = await ethBalanceStep({
      address: ADDRESS,
      integrationId: "int-1",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.address).toBe(ADDRESS);
      expect(result.balanceWei).toBe("0x7b");
      expect(result.balanceNative).toBe("0.000000000000000123");
    }
  });

  it("returns chain id and latest block for chain-info", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });
    safeFetch
      .mockResolvedValueOnce(rpcOk("0x2105"))
      .mockResolvedValueOnce(rpcOk("0x1234"));

    const result = await chainInfoStep({ integrationId: "int-1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.chainId).toBe("0x2105");
      expect(result.chainIdDecimal).toBe(8453);
      expect(result.latestBlock).toBe(4660);
    }
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("returns the ERC-20 balance as a decimal string", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });
    const word = `0x${"0".repeat(62)}1234`;
    safeFetch.mockResolvedValue(rpcOk(word));

    const result = await erc20BalanceStep({
      token: ADDRESS,
      holder: ADDRESS,
      integrationId: "int-1",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balance).toBe("4660");
    }
  });

  it("rejects a short ERC-20 balanceOf word", async () => {
    mockFetchCredentials.mockResolvedValue({ EVM_CHAIN_RPC_URL: PUBLIC_URL });
    safeFetch.mockResolvedValue(rpcOk("0x1234"));

    const result = await erc20BalanceStep({
      token: ADDRESS,
      holder: ADDRESS,
      integrationId: "int-1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unexpected balanceOf response");
    }
  });
});
