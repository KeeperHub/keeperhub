import { decodeFunctionData } from "viem";
import { Abis } from "viem/tempo";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// supported_tokens rows the stablecoin ceiling reads, set per test.
const registry = vi.hoisted(() => ({
  tokenRows: [] as Array<{
    tokenAddress: string;
    decimals: number;
    symbol: string;
    isStablecoin: boolean;
  }>,
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(registry.tokenRows) }),
    }),
  },
}));

// tempo-tx-core pulls the Turnkey / signer / wallet / RPC modules at import
// time; stub them so the pure helpers can be exercised without infra.
vi.mock("@/lib/turnkey/turnkey-client", () => ({
  getTurnkeySignerConfig: vi.fn(),
}));
vi.mock("@/lib/safe/signer-resolver", () => ({
  resolveSignerMode: vi.fn(),
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: vi.fn(),
}));
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

import { resolveSignerMode } from "@/lib/safe/signer-resolver";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";
import {
  applyTempoMemoGasFloor,
  buildSwapExactAmountInCall,
  buildTransferWithMemoCall,
  deriveTempoNonceKey,
  isTempoChain,
  normalizeMemo,
  signTempoTx,
  TEMPO_MEMO_MIN_GAS,
} from "@/plugins/tempo/steps/tempo-tx-core";

const ZERO_MEMO = `0x${"0".repeat(64)}`;
const USDC = "0x20c0000000000000000000000000000000000001" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const TOO_LONG_MEMO = /too long/;

describe("deriveTempoNonceKey", () => {
  const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

  it("gives concurrent sends from one wallet their own lanes", () => {
    // Two sends in the same execution get distinct 2D-nonce lanes, so neither
    // reads a nonce the other is about to consume and both can land.
    const a = deriveTempoNonceKey("exec-1");
    const b = deriveTempoNonceKey("exec-1");
    expect(a).not.toBe(b);
  });

  it("produces a unique lane on every call, with or without an execution id", () => {
    const keys = new Set(
      Array.from({ length: 1000 }, (_, i) =>
        deriveTempoNonceKey(i % 2 === 0 ? "exec" : undefined)
      )
    );
    expect(keys.size).toBe(1000);
  });

  it("stays off lane 0 and the max-uint256 marker lane", () => {
    const keys = Array.from({ length: 1000 }, () =>
      deriveTempoNonceKey(undefined)
    );
    for (const key of keys) {
      expect(key > BigInt(0)).toBe(true);
      expect(key < MAX_UINT256).toBe(true);
    }
  });
});

describe("isTempoChain", () => {
  it("accepts Tempo mainnet and Moderato testnet", () => {
    expect(isTempoChain(4217)).toBe(true);
    expect(isTempoChain(42_431)).toBe(true);
  });

  it("rejects non-Tempo chains", () => {
    expect(isTempoChain(1)).toBe(false);
    expect(isTempoChain(8453)).toBe(false);
  });
});

describe("normalizeMemo", () => {
  it("returns a zero bytes32 for empty or missing memo", () => {
    expect(normalizeMemo(undefined)).toBe(ZERO_MEMO);
    expect(normalizeMemo("")).toBe(ZERO_MEMO);
    expect(normalizeMemo("   ")).toBe(ZERO_MEMO);
  });

  it("passes a 0x + 64-hex bytes32 through verbatim", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(normalizeMemo(hash)).toBe(hash);
  });

  it("right-pads a short plain-text memo (Solidity bytes32-string form)", () => {
    const memo = normalizeMemo("INV-1042");
    // "INV-1042" utf8 in the leading bytes, zero-padded on the right.
    expect(memo.startsWith("0x494e562d31303432")).toBe(true);
    expect(memo).toHaveLength(66);
    expect(memo.endsWith("00")).toBe(true);
  });

  it("throws when a plain-text memo exceeds 31 bytes", () => {
    expect(() => normalizeMemo("x".repeat(32))).toThrow(TOO_LONG_MEMO);
  });
});

describe("buildTransferWithMemoCall", () => {
  it("targets the token and encodes transferWithMemo(to, value, memo)", () => {
    const memo = normalizeMemo("INV-1042");
    const call = buildTransferWithMemoCall(
      USDC,
      RECIPIENT,
      BigInt(1_500_000),
      memo
    );

    expect(call.to).toBe(USDC);
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data });
    expect(decoded.functionName).toBe("transferWithMemo");
    expect(decoded.args).toEqual([RECIPIENT, BigInt(1_500_000), memo]);
  });
});

describe("applyTempoMemoGasFloor", () => {
  const memoCall = buildTransferWithMemoCall(
    USDC,
    RECIPIENT,
    BigInt(1_500_000),
    normalizeMemo("benchmark")
  );
  // A memo transfer's real settlement cost observed on Tempo testnet.
  const REAL_MEMO_GAS = BigInt(272_108);
  // What eth_estimateGas returns for it, below even a plain transfer.
  const UNDERESTIMATE = BigInt(35_770);

  it("raises a memo transfer's underestimate to a floor that covers real cost", () => {
    const floored = applyTempoMemoGasFloor(memoCall, UNDERESTIMATE);
    expect(floored).toBe(TEMPO_MEMO_MIN_GAS);
    expect(TEMPO_MEMO_MIN_GAS).toBeGreaterThan(REAL_MEMO_GAS);
  });

  it("keeps a memo estimate that already exceeds the floor", () => {
    const high = TEMPO_MEMO_MIN_GAS + BigInt(50_000);
    expect(applyTempoMemoGasFloor(memoCall, high)).toBe(high);
  });

  it("leaves a call that is not a memo transfer (DEX swap) untouched", () => {
    const swapCall = buildSwapExactAmountInCall(
      USDC,
      RECIPIENT,
      BigInt(1_000_000),
      BigInt(990_000)
    );
    expect(applyTempoMemoGasFloor(swapCall, UNDERESTIMATE)).toBe(UNDERESTIMATE);
  });
});

describe("signTempoTx stablecoin ceiling", () => {
  beforeEach(() => {
    vi.mocked(resolveSignerMode).mockResolvedValue({
      kind: "eoa",
    } as Awaited<ReturnType<typeof resolveSignerMode>>);
    registry.tokenRows = [
      {
        tokenAddress: USDC,
        decimals: 6,
        symbol: "USDC",
        isStablecoin: true,
      },
    ];
  });

  it("refuses an over-cap TIP-20 transfer before signing", async () => {
    // Tempo has no native gas token at all, so the daily value cap never sees a
    // Tempo send; every Tempo write is signed through here.
    await expect(
      signTempoTx({
        organizationId: "org-1",
        userId: "user-1",
        chainId: 4217,
        feeToken: USDC,
        calls: [
          buildTransferWithMemoCall(
            USDC,
            RECIPIENT,
            BigInt(5000) * BigInt(10) ** BigInt(6),
            normalizeMemo("invoice-1")
          ),
        ],
      })
    ).rejects.toThrow(/per-transaction limit/);

    expect(getOrganizationWallet).not.toHaveBeenCalled();
  });

  it("checks every call in a batch, not just the first", async () => {
    await expect(
      signTempoTx({
        organizationId: "org-1",
        userId: "user-1",
        chainId: 4217,
        feeToken: USDC,
        calls: [
          buildTransferWithMemoCall(
            USDC,
            RECIPIENT,
            BigInt(1) * BigInt(10) ** BigInt(6),
            normalizeMemo("small")
          ),
          buildTransferWithMemoCall(
            USDC,
            RECIPIENT,
            BigInt(9000) * BigInt(10) ** BigInt(6),
            normalizeMemo("large")
          ),
        ],
      })
    ).rejects.toThrow(/per-transaction limit/);
  });
});
