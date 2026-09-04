import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PublicKey } from "@solana/web3.js";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { readSolanaAccountCore } from "@/plugins/web3/steps/read-solana-account-core";

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logUserError: vi.fn(),
}));

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OWNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("readSolanaAccountCore", () => {
  let mockAdapter: {
    executeWithSolanaFailover: ReturnType<typeof vi.fn>;
    getAddressUrl: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockAdapter = {
      executeWithSolanaFailover: vi.fn(),
      getAddressUrl: vi
        .fn()
        .mockResolvedValue(`https://solscan.io/account/${ADDRESS}`),
    };

    vi.mocked(getChainAdapter).mockReturnValue(mockAdapter as never);
  });

  it("returns exists:false for a missing account", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue(null);

    const result = await readSolanaAccountCore({
      network: "solana-devnet",
      accountAddress: ADDRESS,
    });

    expect(result).toEqual({ success: true, exists: false });
  });

  it("returns raw account info for an existing account", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue({
      executable: false,
      owner: new PublicKey(OWNER),
      lamports: 2_039_280,
      data: Buffer.from([1, 2, 3, 4]),
      rentEpoch: 361,
    });

    const result = await readSolanaAccountCore({
      network: "solana-devnet",
      accountAddress: ADDRESS,
    });

    expect(result).toMatchObject({
      success: true,
      exists: true,
      owner: OWNER,
      lamports: 2_039_280,
      executable: false,
      rentEpoch: 361,
      dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      dataLength: 4,
    });
    expect((result as { addressLink: string }).addressLink).toBe(
      `https://solscan.io/account/${ADDRESS}`
    );
  });

  it("defaults a missing rentEpoch to null", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue({
      executable: false,
      owner: new PublicKey(OWNER),
      lamports: 100,
      data: Buffer.alloc(0),
      rentEpoch: undefined,
    });

    const result = await readSolanaAccountCore({
      network: "solana-devnet",
      accountAddress: ADDRESS,
    });

    expect(result).toMatchObject({ success: true, rentEpoch: null });
  });

  it("rejects a non-Solana network without touching the adapter", async () => {
    const result = await readSolanaAccountCore({
      network: "ethereum",
      accountAddress: ADDRESS,
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Only supported on Solana networks"
    );
    expect(getChainAdapter).not.toHaveBeenCalled();
  });

  it("rejects an invalid address", async () => {
    const result = await readSolanaAccountCore({
      network: "solana-devnet",
      accountAddress: "not-a-pubkey!!",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Invalid Solana address"
    );
  });

  it("surfaces an RPC failure", async () => {
    mockAdapter.executeWithSolanaFailover.mockRejectedValue(
      new Error("RPC down")
    );

    const result = await readSolanaAccountCore({
      network: "solana-devnet",
      accountAddress: ADDRESS,
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Failed to read account"
    );
  });
});

describe("readSolanaAccountCore - failOnError", () => {
  let mockAdapter: {
    executeWithSolanaFailover: ReturnType<typeof vi.fn>;
    getAddressUrl: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = {
      executeWithSolanaFailover: vi
        .fn()
        .mockRejectedValue(new Error("RPC down")),
      getAddressUrl: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getChainAdapter).mockReturnValue(mockAdapter as never);
  });

  it("softens a failed read into exists:null when the toggle is off", async () => {
    const result = await readSolanaAccountCore({
      network: "solana-devnet",
      accountAddress: ADDRESS,
      failOnError: false,
    });

    // exists must not be false: a read that never completed cannot report the
    // account as absent.
    expect(result).toMatchObject({ success: true, exists: null });
    expect((result as { error: string }).error).toContain(
      "Failed to read account"
    );
  });

  it("still hard-fails an invalid address when the toggle is off", async () => {
    const result = await readSolanaAccountCore({
      network: "solana-devnet",
      accountAddress: "not-a-pubkey!!",
      failOnError: false,
    });

    expect(result).toMatchObject({ success: false });
  });
});
