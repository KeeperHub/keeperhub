import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  ORG_WALLETS,
  CHAINS,
  mockWalletRows,
  mockChainRows,
  mockGetDualAuthContext,
  mockGetChainAdapter,
} = vi.hoisted(() => ({
  ORG_WALLETS: { __table: "organization_wallets" },
  CHAINS: { __table: "chains" },
  mockWalletRows: vi.fn(),
  mockChainRows: vi.fn(),
  mockGetDualAuthContext: vi.fn(),
  mockGetChainAdapter: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
}));

vi.mock("ethers", () => ({
  ethers: {
    formatUnits: (value: bigint, decimals: number) =>
      (Number(value) / 10 ** decimals).toString(),
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === ORG_WALLETS) {
            return { limit: () => Promise.resolve(mockWalletRows()) };
          }
          return Promise.resolve(mockChainRows());
        },
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationWallets: ORG_WALLETS,
  chains: CHAINS,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "NETWORK_RPC", DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockGetDualAuthContext(...args),
}));

vi.mock("@/lib/web3/chain-adapter/registry", () => ({
  getChainAdapter: (...args: unknown[]) => mockGetChainAdapter(...args),
}));

import { GET } from "@/app/api/user/wallet/solana-balance/route";

const ORG_ID = "org-1";
const SOL_ADDRESS = "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL";

function request(): Request {
  return new Request("http://localhost:3000/api/user/wallet/solana-balance");
}

const SOLANA_CHAINS = [
  { chainId: 101, name: "Solana", isTestnet: false },
  { chainId: 103, name: "Solana Devnet", isTestnet: true },
];

describe("GET /api/user/wallet/solana-balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({ organizationId: ORG_ID });
  });

  it("returns live per-network balances for the org Solana address", async () => {
    mockWalletRows.mockResolvedValue([{ solanaAddress: SOL_ADDRESS }]);
    mockChainRows.mockResolvedValue(SOLANA_CHAINS);
    // 2.5 SOL on mainnet, 1 SOL on devnet
    mockGetChainAdapter.mockImplementation((chainId: number) => ({
      getBalance: () =>
        Promise.resolve(
          chainId === 101 ? BigInt(2_500_000_000) : BigInt(1_000_000_000)
        ),
    }));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.hasSolanaWallet).toBe(true);
    expect(body.address).toBe(SOL_ADDRESS);
    expect(body.balances).toHaveLength(2);
    expect(body.balances[0]).toMatchObject({
      chainId: 101,
      chainName: "Solana",
      isTestnet: false,
      balanceLamports: "2500000000",
      balanceSol: "2.5",
      error: false,
    });
    expect(body.balances[1]).toMatchObject({
      chainId: 103,
      balanceSol: "1",
      error: false,
    });
  });

  it("returns hasSolanaWallet:false when the wallet has no Solana address", async () => {
    mockWalletRows.mockResolvedValue([{ solanaAddress: null }]);

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ hasSolanaWallet: false, balances: [] });
    // No chain fan-out when there is no address.
    expect(mockGetChainAdapter).not.toHaveBeenCalled();
  });

  it("marks a chain as error when its balance fetch throws, without failing the request", async () => {
    mockWalletRows.mockResolvedValue([{ solanaAddress: SOL_ADDRESS }]);
    mockChainRows.mockResolvedValue(SOLANA_CHAINS);
    mockGetChainAdapter.mockImplementation((chainId: number) => ({
      getBalance: () => {
        if (chainId === 103) {
          return Promise.reject(new Error("RPC down"));
        }
        return Promise.resolve(BigInt(2_500_000_000));
      },
    }));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.hasSolanaWallet).toBe(true);
    const mainnet = body.balances.find(
      (b: { chainId: number }) => b.chainId === 101
    );
    const devnet = body.balances.find(
      (b: { chainId: number }) => b.chainId === 103
    );
    expect(mainnet).toMatchObject({ error: false, balanceSol: "2.5" });
    expect(devnet).toMatchObject({ error: true, balanceSol: "" });
  });

  it("returns the auth error when unauthenticated", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });
});
