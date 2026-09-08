import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { readSolanaProgramCore } from "@/plugins/web3/steps/read-solana-program-core";

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logUserError: vi.fn(),
}));

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const AUTHORITY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// A minimal Anchor 0.30+ IDL with one account type (per-account discriminator).
function fixtureIdl() {
  return {
    address: PROGRAM,
    metadata: { name: "fixture", version: "0.1.0", spec: "0.1.0" },
    instructions: [
      {
        name: "do_thing",
        discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        accounts: [],
        args: [],
      },
    ],
    accounts: [
      { name: "Vault", discriminator: [10, 20, 30, 40, 50, 60, 70, 80] },
    ],
    types: [
      {
        name: "Vault",
        type: {
          kind: "struct",
          fields: [
            { name: "authority", type: "pubkey" },
            { name: "amount", type: "u64" },
          ],
        },
      },
    ],
  };
}

async function encodedVault(
  authority: string,
  amount: string
): Promise<Buffer> {
  const coder = new BorshAccountsCoder(fixtureIdl() as never);
  return coder.encode("Vault", {
    authority: new PublicKey(authority),
    amount: new BN(amount),
  });
}

describe("readSolanaProgramCore", () => {
  let mockAdapter: {
    executeWithSolanaFailover: ReturnType<typeof vi.fn>;
    getAddressUrl: ReturnType<typeof vi.fn>;
  };

  const validInput = {
    network: "solana-devnet",
    accountAddress: ADDRESS,
    programId: PROGRAM,
    idl: JSON.stringify(fixtureIdl()),
    accountType: "Vault",
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

  it("decodes an existing account against the IDL", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue({
      executable: false,
      owner: new PublicKey(PROGRAM),
      lamports: 2_039_280,
      data: await encodedVault(AUTHORITY, "1000000"),
      rentEpoch: 1,
    });

    const result = await readSolanaProgramCore(validInput);

    expect(result).toMatchObject({
      success: true,
      owner: PROGRAM,
      lamports: 2_039_280,
      result: { authority: AUTHORITY, amount: "1000000" },
    });
  });

  it("rejects a non-Solana network without touching the adapter", async () => {
    const result = await readSolanaProgramCore({
      ...validInput,
      network: "ethereum",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Only supported on Solana networks"
    );
    expect(getChainAdapter).not.toHaveBeenCalled();
  });

  it("rejects an invalid program id", async () => {
    const result = await readSolanaProgramCore({
      ...validInput,
      programId: "not-a-program!!",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Invalid Solana program address"
    );
  });

  it("rejects an IDL that is not valid JSON", async () => {
    const result = await readSolanaProgramCore({ ...validInput, idl: "{bad" });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("not valid JSON");
  });

  it("rejects an unknown account type, listing what is available", async () => {
    const result = await readSolanaProgramCore({
      ...validInput,
      accountType: "Nope",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      'Account type "Nope" not found'
    );
    expect((result as { error: string }).error).toContain("Vault");
  });

  it("errors when the account does not exist", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue(null);

    const result = await readSolanaProgramCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("Account not found");
  });

  it("errors when the account is not owned by the given program", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue({
      executable: false,
      owner: new PublicKey(AUTHORITY),
      lamports: 100,
      data: await encodedVault(AUTHORITY, "1"),
      rentEpoch: 1,
    });

    const result = await readSolanaProgramCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("is owned by");
    expect((result as { error: string }).error).toContain(
      "not the expected program"
    );
  });

  it("errors when the account data does not match the account type's discriminator", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue({
      executable: false,
      owner: new PublicKey(PROGRAM),
      lamports: 100,
      data: Buffer.alloc(16, 0),
      rentEpoch: 1,
    });

    const result = await readSolanaProgramCore(validInput);

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      'Failed to decode account as "Vault"'
    );
  });

  it("tolerates whitespace around accountType", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue({
      executable: false,
      owner: new PublicKey(PROGRAM),
      lamports: 2_039_280,
      data: await encodedVault(AUTHORITY, "1000000"),
      rentEpoch: 1,
    });

    const result = await readSolanaProgramCore({
      ...validInput,
      accountType: "  Vault\n",
    });

    expect(result).toMatchObject({
      success: true,
      result: { authority: AUTHORITY, amount: "1000000" },
    });
  });

  it("rejects a malformed IDL where accounts is not an array, without throwing", async () => {
    const idl = { ...fixtureIdl(), accounts: {} };

    const result = await readSolanaProgramCore({
      ...validInput,
      idl: JSON.stringify(idl),
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      'Account type "Vault" not found'
    );
  });
});

describe("readSolanaProgramCore - failOnError", () => {
  let mockAdapter: {
    executeWithSolanaFailover: ReturnType<typeof vi.fn>;
    getAddressUrl: ReturnType<typeof vi.fn>;
  };

  const validInput = {
    network: "solana-devnet",
    accountAddress: ADDRESS,
    programId: PROGRAM,
    idl: JSON.stringify(fixtureIdl()),
    accountType: "Vault",
    failOnError: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = {
      executeWithSolanaFailover: vi.fn(),
      getAddressUrl: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getChainAdapter).mockReturnValue(mockAdapter as never);
  });

  it("softens a failed read when the toggle is off", async () => {
    mockAdapter.executeWithSolanaFailover.mockRejectedValue(
      new Error("RPC down")
    );

    const result = await readSolanaProgramCore(validInput);

    expect(result).toMatchObject({ success: true, result: null, owner: null });
  });

  it("softens a missing account when the toggle is off", async () => {
    mockAdapter.executeWithSolanaFailover.mockResolvedValue(null);

    const result = await readSolanaProgramCore(validInput);

    expect(result).toMatchObject({ success: true, result: null });
    expect((result as { error?: string }).error).toContain("Account not found");
  });

  it("softens a malformed IDL, which is payload not destination", async () => {
    const result = await readSolanaProgramCore({
      ...validInput,
      idl: "{bad",
    });

    expect(result).toMatchObject({ success: true, result: null });
  });

  it("still hard-fails an invalid account address when the toggle is off", async () => {
    const result = await readSolanaProgramCore({
      ...validInput,
      accountAddress: "not-a-pubkey!!",
    });

    expect(result).toMatchObject({ success: false });
  });
});
