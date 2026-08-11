import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisterDeps } from "../../scripts/register-agent";
import {
  IDENTITY_REGISTRY_ADDRESS,
  registerAgent,
  TRANSFER_TOPIC,
} from "../../scripts/register-agent";

vi.mock("dotenv/config", () => ({}));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn() }));
vi.mock("postgres", () => ({ default: vi.fn() }));
vi.mock("ethers", () => ({ ethers: {} }));
vi.mock("../../lib/db/connection-utils", () => ({
  getDatabaseUrl: vi.fn(() => "postgres://localhost:5432/test"),
}));
vi.mock("../../lib/db/schema", () => ({
  agentRegistrations: {
    id: "id",
    chainId: "chain_id",
    registryAddress: "registry_address",
  },
}));
vi.mock("../../lib/rpc/rpc-config", () => ({
  getRpcUrlByChainId: vi.fn(() => "https://eth-mainnet.example.com"),
}));

const AGENT_ID_42 = BigInt(42);
const AGENT_ID_12345 = BigInt(12_345);

const INSUFFICIENT_BALANCE_RE = /insufficient balance/;
const REVERTED_ON_CHAIN_RE = /reverted on-chain/;

function makeReceipt(agentId: bigint) {
  return {
    status: 1,
    logs: [
      {
        topics: [
          TRANSFER_TOPIC,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x000000000000000000000000testwalletaddress00000000000000000000000",
          `0x${agentId.toString(16).padStart(64, "0")}`,
        ],
        address: IDENTITY_REGISTRY_ADDRESS,
      },
    ],
  };
}

function makeDeps(overrides: Partial<RegisterDeps> = {}): RegisterDeps {
  const mockSelectRows: unknown[] = [];
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockContractRegister = vi.fn();

  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockSelectRows),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
    },
    buildProvider: vi.fn().mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(BigInt("10000000000000000")), // 0.01 ETH, well above floor
    }),
    buildWallet: vi.fn().mockReturnValue({ address: "0xTestWallet" }),
    buildContract: vi.fn().mockReturnValue({ register: mockContractRegister }),
    ...overrides,
  };
}

describe("registerAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test 1: when DB already has a registration row, exits without sending any transaction", async () => {
    process.env.REGISTRATION_PRIVATE_KEY = "0xdeadbeef";

    const existingRow = {
      id: "existing-id",
      agentId: "99",
      txHash: "0xexistinghash",
      registeredAt: new Date(),
      chainId: 1,
      registryAddress: IDENTITY_REGISTRY_ADDRESS,
    };

    const mockContractRegister = vi.fn();
    const deps = makeDeps({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn() }),
      },
      buildContract: vi
        .fn()
        .mockReturnValue({ register: mockContractRegister }),
    });

    const result = await registerAgent(deps);

    expect(result).toEqual({ alreadyRegistered: true, agentId: "99" });
    expect(mockContractRegister).not.toHaveBeenCalled();
  });

  it("Test 2: when DB is empty and REGISTRATION_PRIVATE_KEY is not set, throws an error", async () => {
    // biome-ignore lint/performance/noDelete: delete is required to remove env vars (undefined assignment coerces to string)
    delete process.env.REGISTRATION_PRIVATE_KEY;

    const mockContractRegister = vi.fn();
    const deps = makeDeps({
      buildContract: vi
        .fn()
        .mockReturnValue({ register: mockContractRegister }),
    });

    await expect(registerAgent(deps)).rejects.toThrow(
      "REGISTRATION_PRIVATE_KEY environment variable is required"
    );
    expect(mockContractRegister).not.toHaveBeenCalled();
  });

  it("Test 3: when registration succeeds, inserts agentId, txHash, chainId=1, and registryAddress into DB", async () => {
    process.env.REGISTRATION_PRIVATE_KEY = "0xdeadbeef";

    const mockTxWait = vi.fn().mockResolvedValue(makeReceipt(AGENT_ID_42));
    const mockTx = { hash: "0xnewtxhash", wait: mockTxWait };
    const mockContractRegister = vi.fn().mockResolvedValue(mockTx);
    const mockInsertValues = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
      },
      buildContract: vi
        .fn()
        .mockReturnValue({ register: mockContractRegister }),
    });

    const result = await registerAgent(deps);

    expect(result).toEqual({ agentId: "42", txHash: "0xnewtxhash" });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "42",
        txHash: "0xnewtxhash",
        chainId: 1,
        registryAddress: IDENTITY_REGISTRY_ADDRESS,
      })
    );
  });

  it("Test 4: agentId is extracted from ERC-721 Transfer event topic[3] in the tx receipt", async () => {
    process.env.REGISTRATION_PRIVATE_KEY = "0xdeadbeef";

    const mockTxWait = vi.fn().mockResolvedValue(makeReceipt(AGENT_ID_12345));
    const mockTx = { hash: "0xabc", wait: mockTxWait };
    const mockContractRegister = vi.fn().mockResolvedValue(mockTx);
    const mockInsertValues = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
      },
      buildContract: vi
        .fn()
        .mockReturnValue({ register: mockContractRegister }),
    });

    const result = await registerAgent(deps);

    expect(result).toEqual({
      agentId: AGENT_ID_12345.toString(),
      txHash: "0xabc",
    });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_ID_12345.toString() })
    );
  });

  it("Test 5: throws and does not call register() when wallet balance is below the floor", async () => {
    process.env.REGISTRATION_PRIVATE_KEY = "0xdeadbeef";

    const mockContractRegister = vi.fn();
    const mockInsertValues = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
      },
      buildProvider: vi.fn().mockReturnValue({
        getBalance: vi.fn().mockResolvedValue(BigInt("1000000000000000")), // 0.001 ETH, below the 0.005 floor
      }),
      buildContract: vi
        .fn()
        .mockReturnValue({ register: mockContractRegister }),
    });

    await expect(registerAgent(deps)).rejects.toThrow(INSUFFICIENT_BALANCE_RE);
    expect(mockContractRegister).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("Test 6: throws when transaction receipt has status 0 (reverted)", async () => {
    process.env.REGISTRATION_PRIVATE_KEY = "0xdeadbeef";

    const revertedReceipt = { ...makeReceipt(AGENT_ID_42), status: 0 };
    const mockTxWait = vi.fn().mockResolvedValue(revertedReceipt);
    const mockTx = { hash: "0xreverted", wait: mockTxWait };
    const mockContractRegister = vi.fn().mockResolvedValue(mockTx);
    const mockInsertValues = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
      },
      buildContract: vi
        .fn()
        .mockReturnValue({ register: mockContractRegister }),
    });

    await expect(registerAgent(deps)).rejects.toThrow(REVERTED_ON_CHAIN_RE);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});
