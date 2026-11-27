import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("ethers", () => ({
  ethers: {
    isAddress: vi.fn((a: string) => a.startsWith("0x") && a.length === 42),
    formatUnits: vi.fn((value: bigint, decimals: number) =>
      (Number(value) / 10 ** decimals).toString()
    ),
  },
}));

// Real, well-known program IDs - needed so parseSolanaMintAccount's
// programId.equals(TOKEN_PROGRAM_ID) checks behave like the real library.
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const { mockUnpackMint, mockUnpackAccount, mockGetAssociatedTokenAddressSync } =
  vi.hoisted(() => ({
    mockUnpackMint: vi.fn(),
    mockUnpackAccount: vi.fn(),
    mockGetAssociatedTokenAddressSync: vi.fn(),
  }));

vi.mock("@solana/spl-token", async () => {
  const actual =
    await vi.importActual<typeof import("@solana/spl-token")>(
      "@solana/spl-token"
    );
  return {
    TOKEN_PROGRAM_ID: actual.TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID: actual.TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID: actual.ASSOCIATED_TOKEN_PROGRAM_ID,
    unpackMint: (...args: unknown[]) => mockUnpackMint(...args),
    unpackAccount: (...args: unknown[]) => mockUnpackAccount(...args),
    getAssociatedTokenAddressSync: (...args: unknown[]) =>
      mockGetAssociatedTokenAddressSync(...args),
  };
});

const { mockConnectionGetAccountInfo, mockGetAddressUrl, mockGetChainAdapter } =
  vi.hoisted(() => ({
    mockConnectionGetAccountInfo: vi.fn(),
    mockGetAddressUrl: vi.fn(),
    mockGetChainAdapter: vi.fn(),
  }));

// The registry pulls in EvmChainAdapter -> nonce-manager -> schema's drizzle
// sql() helper, so it is stubbed with a fake Solana adapter that hands back a
// fake connection.
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: (...args: unknown[]) => mockGetChainAdapter(...args),
}));

const fakeSolanaAdapter = {
  executeWithSolanaFailover: (fn: (connection: unknown) => unknown) =>
    fn({
      getAccountInfo: (...args: unknown[]) =>
        mockConnectionGetAccountInfo(...args),
    }),
  getAddressUrl: (...args: unknown[]) => mockGetAddressUrl(...args),
};

vi.mock("@/lib/rpc/engine", async () => ({
  ...(await vi.importActual("@/lib/rpc/engine/types")),
  ...(await vi.importActual("@/lib/rpc/engine/scope")),
  ...(await vi.importActual("@/lib/rpc/engine/route-error")),
  rpc: { evm: vi.fn(), solana: vi.fn() },
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn((network: string) => {
    if (network === "solana-devnet") {
      return 103;
    }
    if (network === "sepolia") {
      return 11_155_111;
    }
    throw new Error(`Unsupported network: ${network}`);
  }),
}));

// The supportedTokens address lookup (selects tokenAddress) resolves the mint
// for supported-token configs; the supportedTokens display-info lookup
// (selects symbol/name) finds no row, so the Metaplex fallback is reachable.
vi.mock("@/lib/security/org-role", () => ({
  getOrgRole: () => Promise.resolve("member"),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (shape: Record<string, unknown>) => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                { userId: "user_1", executionOrganizationId: "org_1" },
              ]),
          }),
        }),
        where: () => ({
          limit: () => {
            if ("tokenAddress" in shape) {
              return Promise.resolve([
                {
                  tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                },
              ]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  supportedTokens: {
    chainId: "chainId",
    id: "id",
    tokenAddress: "tokenAddress",
    symbol: "symbol",
    name: "name",
  },
  workflowExecutions: { id: "id", userId: "userId" },
  workflows: { id: "id", organizationId: "organizationId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", NETWORK_RPC: "network_rpc" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    getErrorMessage: (error: { message?: string }) =>
      error?.message ?? String(error),
  };
});

import { RpcScopeKind } from "@/lib/rpc/engine/types";
import { checkTokenBalanceStep } from "@/plugins/web3/steps/check-token-balance";
import { getSplTokenBalanceStep } from "@/plugins/web3/steps/get-spl-token-balance";

const WALLET = "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL";
const OFF_CURVE_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "4gZfWA6UftMD8W3XqPB8p7cN8G2p9J4ELuTFCe4gTaeM";

function fakeAccountInfo(owner: PublicKey) {
  return { owner, data: Buffer.alloc(0), lamports: 0, executable: false };
}

/**
 * Builds a Metaplex metadata account payload the way the on-chain program
 * writes it: key (1) + updateAuthority (32) + mint (32), then borsh strings
 * whose declared length includes trailing null padding.
 */
function fakeMetadataAccountInfo(name: string, symbol: string) {
  const paddedName = Buffer.alloc(32);
  paddedName.write(name, "utf8");
  const paddedSymbol = Buffer.alloc(10);
  paddedSymbol.write(symbol, "utf8");

  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32LE(paddedName.length);
  const symbolLen = Buffer.alloc(4);
  symbolLen.writeUInt32LE(paddedSymbol.length);

  const data = Buffer.concat([
    Buffer.alloc(65),
    nameLen,
    paddedName,
    symbolLen,
    paddedSymbol,
  ]);
  return {
    owner: METAPLEX_METADATA_PROGRAM_ID,
    data,
    lamports: 0,
    executable: false,
  };
}

const context = () => ({
  executionId: "exec_1",
  organizationId: "org_1",
  nodeId: "node_1",
  nodeName: "Get SPL Balance",
  nodeType: "get-spl-token-balance" as const,
});

const input = () => ({
  network: "solana-devnet",
  address: WALLET,
  tokenConfig: {
    mode: "custom",
    customToken: { address: MINT, symbol: "TEST" },
  },
  _context: context(),
});

describe("getSplTokenBalanceStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChainAdapter.mockReturnValue(fakeSolanaAdapter);
    mockGetAssociatedTokenAddressSync.mockReturnValue(new PublicKey(ATA));
    mockGetAddressUrl.mockResolvedValue(
      "https://solscan.io/account/x?cluster=devnet"
    );
  });

  it("fetches a legacy SPL token balance for a funded associated token account", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // mint account
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)); // ATA account
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(5_000_000) });

    const result = await getSplTokenBalanceStep(input());

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.balance).toBe("5");
      expect(result.balance.balanceRaw).toBe("5000000");
      expect(result.balance.decimals).toBe(6);
      expect(result.balance.symbol).toBe("TEST");
      expect(result.balance.tokenAddress).toBe(MINT);
    }
    // getAssociatedTokenAddressSync's allowOwnerOffCurve argument (3rd) must
    // be true - checking a PDA-owned wallet's balance is legitimate.
    expect(mockGetAssociatedTokenAddressSync).toHaveBeenCalledWith(
      expect.any(PublicKey),
      expect.any(PublicKey),
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  it("fetches a Token-2022 mint's balance instead of failing with an owner-mismatch error", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_2022_PROGRAM_ID))
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_2022_PROGRAM_ID))
      .mockResolvedValueOnce(null); // no metadata account
    mockUnpackMint.mockReturnValue({ decimals: 9 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(1_000_000_000) });

    const result = await getSplTokenBalanceStep({
      ...input(),
      tokenConfig: MINT,
    });

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.balance).toBe("1");
    }
    expect(mockUnpackMint).toHaveBeenCalledWith(
      expect.any(PublicKey),
      expect.anything(),
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("returns a zero balance when the wallet has no associated token account", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // mint account
      .mockResolvedValueOnce(null); // no ATA yet
    mockUnpackMint.mockReturnValue({ decimals: 9 });

    const result = await getSplTokenBalanceStep(input());

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.balance).toBe("0");
      expect(result.balance.balanceRaw).toBe("0");
    }
    expect(mockUnpackAccount).not.toHaveBeenCalled();
  });

  it("fetches the balance of an off-curve (PDA-owned) wallet address", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID));
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(2_000_000) });

    const result = await getSplTokenBalanceStep({
      ...input(),
      address: OFF_CURVE_WALLET,
    });

    expect(result.success).toBe(true);
  });

  it("resolves symbol and name from the Metaplex metadata account when the config supplies none", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // mint
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // ATA
      .mockResolvedValueOnce(fakeMetadataAccountInfo("USD Coin", "USDC"));
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(1_000_000) });

    const result = await getSplTokenBalanceStep({
      ...input(),
      tokenConfig: MINT, // bare address - parser records the "???" sentinel
    });

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.symbol).toBe("USDC");
      expect(result.balance.name).toBe("USD Coin");
    }

    // The third read must target the canonical Metaplex metadata PDA - a
    // wrong seed order or program id would silently resolve to sentinels.
    const [expectedMetadataAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METAPLEX_METADATA_PROGRAM_ID.toBuffer(),
        new PublicKey(MINT).toBuffer(),
      ],
      METAPLEX_METADATA_PROGRAM_ID
    );
    const metadataCallArg = mockConnectionGetAccountInfo.mock
      .calls[2][0] as PublicKey;
    expect(metadataCallArg.equals(expectedMetadataAddress)).toBe(true);
  });

  it("falls back to unknown-token sentinels when no metadata account exists", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(null); // no metadata PDA
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(1_000_000) });

    const result = await getSplTokenBalanceStep({
      ...input(),
      tokenConfig: MINT,
    });

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.symbol).toBe("???");
      expect(result.balance.name).toBe("Unknown");
    }
  });

  it("resolves a supported token id to its mint address via the DB", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // mint
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // ATA
      .mockResolvedValueOnce(null); // no metadata account
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(3_000_000) });

    const result = await getSplTokenBalanceStep({
      ...input(),
      tokenConfig: { mode: "supported", supportedTokenId: "tok_1" },
    });

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.tokenAddress).toBe(MINT);
      expect(result.balance.balance).toBe("3");
    }
  });

  it("keeps a successful balance when the metadata lookup itself errors", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // mint
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // ATA
      .mockRejectedValueOnce(new Error("429 rate limited")); // metadata PDA
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(1_000_000) });

    const result = await getSplTokenBalanceStep({
      ...input(),
      tokenConfig: MINT,
    });

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.balance).toBe("1");
      expect(result.balance.symbol).toBe("???");
      expect(result.balance.name).toBe("Unknown");
    }
  });

  it("strips control and bidi characters from on-chain metadata strings", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(
        fakeMetadataAccountInfo("USD\u0000 Coin\u202e", "US\u0000DC")
      );
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(1_000_000) });

    const result = await getSplTokenBalanceStep({
      ...input(),
      tokenConfig: MINT,
    });

    expect(result.success).toBe(true);
    if (result.success && result.balance) {
      expect(result.balance.symbol).toBe("USDC");
      expect(result.balance.name).toBe("USD Coin");
    }
  });

  it("does not fetch metadata when the config already carries a real symbol", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID));
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(1_000_000) });

    const result = await getSplTokenBalanceStep(input());

    expect(result.success).toBe(true);
    // mint + ATA only - no third getAccountInfo for the metadata PDA
    expect(mockConnectionGetAccountInfo).toHaveBeenCalledTimes(2);
  });

  it("resolves the Solana adapter for the step's organization scope", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(null);
    mockUnpackMint.mockReturnValue({ decimals: 6 });

    await getSplTokenBalanceStep(input());

    expect(mockGetChainAdapter).toHaveBeenCalledWith(
      103,
      expect.objectContaining({
        kind: RpcScopeKind.ORG,
        organizationId: "org_1",
      })
    );
  });

  it("propagates a real RPC error instead of treating it as a zero balance", async () => {
    // Once, not persistent: vi.clearAllMocks() does not clear implementations,
    // so a persistent mockRejectedValue would leak into later tests.
    mockConnectionGetAccountInfo.mockRejectedValueOnce(
      new Error("RPC timeout")
    );

    const result = await getSplTokenBalanceStep(input());

    expect(result.success).toBe(false);
  });

  it("rejects a mint that is not owned by an SPL token program", async () => {
    const NOT_A_TOKEN_PROGRAM = new PublicKey(
      "11111111111111111111111111111111"
    );
    mockConnectionGetAccountInfo.mockResolvedValueOnce(
      fakeAccountInfo(NOT_A_TOKEN_PROGRAM)
    );

    const result = await getSplTokenBalanceStep(input());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not an SPL token mint");
    }
  });

  it("rejects an invalid Solana wallet address before touching the chain", async () => {
    const result = await getSplTokenBalanceStep({
      ...input(),
      address: "not a valid base58 address",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid wallet address");
    }
    expect(mockConnectionGetAccountInfo).not.toHaveBeenCalled();
  });

  it("rejects an EVM chain with a pointer to the ERC20 action", async () => {
    const result = await getSplTokenBalanceStep({
      ...input(),
      network: "sepolia",
      address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("only supports Solana chains");
    }
    expect(mockConnectionGetAccountInfo).not.toHaveBeenCalled();
  });
});

describe("checkTokenBalanceStep - Solana rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a Solana chain with a pointer to the SPL action", async () => {
    const result = await checkTokenBalanceStep({
      network: "solana-devnet",
      address: WALLET,
      tokenConfig: MINT,
      _context: { ...context(), nodeType: "check-token-balance" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Get SPL Token Balance");
    }
    expect(mockConnectionGetAccountInfo).not.toHaveBeenCalled();
  });
});

describe("getSplTokenBalanceStep - failOnError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChainAdapter.mockReturnValue(fakeSolanaAdapter);
    mockGetAssociatedTokenAddressSync.mockReturnValue(new PublicKey(ATA));
  });

  it("softens a failed read when the toggle is off", async () => {
    mockConnectionGetAccountInfo.mockRejectedValueOnce(
      new Error("RPC timeout")
    );

    const result = await getSplTokenBalanceStep({
      ...input(),
      failOnError: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    // Null, not a zero balance: a read that never completed must not report
    // the wallet as empty.
    expect(result.balance).toBeNull();
    expect(result.error).toContain("Failed to check token balance");
  });

  it("still hard-fails a Solana rejection on the EVM action when the toggle is off", async () => {
    const result = await checkTokenBalanceStep({
      network: "solana-devnet",
      address: WALLET,
      tokenConfig: MINT,
      failOnError: false,
      _context: { ...context(), nodeType: "check-token-balance" },
    });

    expect(result.success).toBe(false);
  });
});
