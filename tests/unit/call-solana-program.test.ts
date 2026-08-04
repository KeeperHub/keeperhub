import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { encodeAnchorInstruction, parseAnchorIdl } from "@/lib/web3/anchor-idl";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { initializeSolanaWallet } from "@/lib/web3/wallet-helpers";
import { callSolanaProgramCore } from "@/plugins/web3/steps/call-solana-program-core";

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeSolanaWallet: vi.fn(),
}));

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn(),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", TRANSACTION: "transaction" },
  logUserError: vi.fn(),
}));

const WALLET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TARGET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const RECIPIENT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// A minimal Anchor 0.30+ IDL (per-instruction discriminators, writable/signer
// account flags). do_thing exercises a u64 (as BN), a bool, a pubkey arg, a
// signer account, a plain writable account, and a fixed-address account.
function fixtureIdl() {
  return {
    address: PROGRAM,
    metadata: { name: "fixture", version: "0.1.0", spec: "0.1.0" },
    instructions: [
      {
        name: "do_thing",
        discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        accounts: [
          { name: "authority", writable: true, signer: true },
          { name: "target", writable: true },
          { name: "system_program", address: SYSTEM_PROGRAM },
        ],
        args: [
          { name: "amount", type: "u64" },
          { name: "flag", type: "bool" },
          { name: "recipient", type: "pubkey" },
        ],
      },
      {
        name: "do_composite",
        discriminator: [9, 9, 9, 9, 9, 9, 9, 9],
        accounts: [{ name: "authority", signer: true }],
        args: [
          { name: "amounts", type: { vec: "u64" } },
          { name: "maybe", type: { option: "u32" } },
          { name: "blob", type: "bytes" },
          { name: "cfg", type: { defined: { name: "Config" } } },
        ],
      },
    ],
    types: [
      {
        name: "Config",
        type: {
          kind: "struct",
          fields: [
            { name: "flag", type: "bool" },
            { name: "owner", type: "pubkey" },
          ],
        },
      },
    ],
  };
}

function encode(overrides: {
  instructionName?: string;
  args?: Record<string, unknown>;
  accountPubkeys?: Record<string, unknown>;
  idl?: object;
}) {
  return encodeAnchorInstruction({
    idl: (overrides.idl ?? fixtureIdl()) as never,
    instructionName: overrides.instructionName ?? "do_thing",
    args: overrides.args ?? {
      amount: "1000000",
      flag: true,
      recipient: RECIPIENT,
    },
    accountPubkeys: overrides.accountPubkeys ?? {
      authority: WALLET,
      target: TARGET,
    },
    programId: new PublicKey(PROGRAM),
    walletPk: new PublicKey(WALLET),
  });
}

describe("encodeAnchorInstruction", () => {
  it("encodes args + discriminator that round-trip through the coder", () => {
    const result = encode({});
    expect("instruction" in result).toBe(true);
    if (!("instruction" in result)) {
      return;
    }

    const decoded = new BorshInstructionCoder(fixtureIdl() as never).decode(
      Buffer.from(result.instruction.data)
    );
    expect(decoded?.name).toBe("do_thing");
    const data = decoded?.data as {
      amount: BN;
      flag: boolean;
      recipient: PublicKey;
    };
    expect(data.amount.toString()).toBe("1000000");
    expect(data.flag).toBe(true);
    expect(data.recipient.toBase58()).toBe(RECIPIENT);
  });

  it("assembles account metas in IDL order with the right flags", () => {
    const result = encode({});
    if (!("instruction" in result)) {
      throw new Error(result.error);
    }
    const keys = result.instruction.keys;
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(keys[0].pubkey.toBase58()).toBe(WALLET);
    expect(keys[1]).toMatchObject({ isSigner: false, isWritable: true });
    expect(keys[1].pubkey.toBase58()).toBe(TARGET);
    // Fixed-address account auto-filled from the IDL.
    expect(keys[2].pubkey.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it("auto-fills an unspecified signer account with the wallet", () => {
    const result = encode({ accountPubkeys: { target: TARGET } });
    if (!("instruction" in result)) {
      throw new Error(result.error);
    }
    expect(result.instruction.keys[0].pubkey.toBase58()).toBe(WALLET);
    expect(result.instruction.keys[0].isSigner).toBe(true);
  });

  it("rejects a foreign signer account", () => {
    const result = encode({
      accountPubkeys: { authority: TARGET, target: TARGET },
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("only the organization wallet"),
    });
  });

  it("errors on a missing required account", () => {
    const result = encode({ accountPubkeys: { authority: WALLET } });
    expect(result).toMatchObject({
      error: expect.stringContaining("Missing required account: target"),
    });
  });

  it("errors on a missing required argument", () => {
    const result = encode({ args: { flag: true, recipient: RECIPIENT } });
    expect(result).toMatchObject({
      error: expect.stringContaining("Missing argument: amount"),
    });
  });

  it("errors on an unknown instruction", () => {
    const result = encode({ instructionName: "nope" });
    expect(result).toMatchObject({
      error: expect.stringContaining('Instruction "nope" not found'),
    });
  });

  it("rejects an old-format IDL instruction without a discriminator", () => {
    const idl = fixtureIdl();
    // Remove the discriminator to simulate a pre-0.30 IDL.
    const stripped = {
      ...idl,
      instructions: [{ ...idl.instructions[0], discriminator: undefined }],
    };
    const result = encode({ idl: stripped });
    expect(result).toMatchObject({
      error: expect.stringContaining("only Anchor >= 0.30 IDLs are supported"),
    });
  });

  it("rejects an invalid pubkey argument", () => {
    const result = encode({
      args: { amount: "1", flag: false, recipient: "not-a-pubkey!!" },
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("Invalid base58 pubkey"),
    });
  });

  it("rejects a bytes argument whose base64 would silently truncate", () => {
    // "A" passes the base64 charset but is an incomplete group that decodes to
    // zero bytes; the lossless check must reject it rather than encode nothing.
    const result = encode({
      instructionName: "do_composite",
      args: { amounts: [], blob: "A", cfg: { flag: false, owner: RECIPIENT } },
      accountPubkeys: { authority: WALLET },
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("Invalid base64 bytes"),
    });
  });

  it("round-trips vec, option (Some), bytes, and a defined struct", () => {
    const result = encode({
      instructionName: "do_composite",
      args: {
        amounts: ["1", "2", "3"],
        maybe: 42,
        blob: "0xdeadbeef",
        cfg: { flag: true, owner: RECIPIENT },
      },
      accountPubkeys: { authority: WALLET },
    });
    if (!("instruction" in result)) {
      throw new Error(result.error);
    }

    const decoded = new BorshInstructionCoder(fixtureIdl() as never).decode(
      Buffer.from(result.instruction.data)
    );
    expect(decoded?.name).toBe("do_composite");
    const data = decoded?.data as {
      amounts: BN[];
      maybe: number | null;
      blob: Buffer;
      cfg: { flag: boolean; owner: PublicKey };
    };
    expect(data.amounts.map((n) => n.toString())).toEqual(["1", "2", "3"]);
    expect(data.maybe).toBe(42);
    expect(Buffer.from(data.blob)).toEqual(
      Buffer.from([0xde, 0xad, 0xbe, 0xef])
    );
    expect(data.cfg.flag).toBe(true);
    expect(data.cfg.owner.toBase58()).toBe(RECIPIENT);
  });

  it("encodes an omitted option argument as None", () => {
    const result = encode({
      instructionName: "do_composite",
      args: { amounts: [], blob: "", cfg: { flag: false, owner: RECIPIENT } },
      accountPubkeys: { authority: WALLET },
    });
    if (!("instruction" in result)) {
      throw new Error(result.error);
    }

    const decoded = new BorshInstructionCoder(fixtureIdl() as never).decode(
      Buffer.from(result.instruction.data)
    );
    const data = decoded?.data as { maybe: number | null };
    expect(data.maybe).toBe(null);
  });
});

describe("parseAnchorIdl", () => {
  it("rejects invalid JSON", () => {
    const result = parseAnchorIdl("{not json");
    expect(result).toMatchObject({
      error: expect.stringContaining("not valid JSON"),
    });
  });

  it("rejects an object without an instructions array", () => {
    const result = parseAnchorIdl({ metadata: {} });
    expect(result).toMatchObject({
      error: expect.stringContaining("missing an instructions array"),
    });
  });
});

describe("callSolanaProgramCore", () => {
  let mockAdapter: {
    sendTransaction: ReturnType<typeof vi.fn>;
    getTransactionUrl: ReturnType<typeof vi.fn>;
  };

  const validInput = {
    network: "solana-devnet",
    programId: PROGRAM,
    idl: JSON.stringify(fixtureIdl()),
    instruction: "do_thing",
    args: JSON.stringify({
      amount: "1000000",
      flag: true,
      recipient: RECIPIENT,
    }),
    accounts: JSON.stringify({ target: TARGET }),
    maxSol: "1",
    _context: { organizationId: "mock-org-id" },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockAdapter = {
      sendTransaction: vi.fn().mockResolvedValue({
        hash: "mock-signature",
        gasUsed: BigInt(4521),
        effectiveGasPrice: BigInt(10),
      }),
      getTransactionUrl: vi
        .fn()
        .mockResolvedValue("https://solscan.io/tx/mock-signature"),
    };

    vi.mocked(getChainAdapter).mockReturnValue(mockAdapter as never);
    vi.mocked(resolveOrganizationContext).mockResolvedValue({
      success: true,
      organizationId: "mock-org-id",
      userId: "mock-user-id",
    } as never);
    vi.mocked(initializeSolanaWallet).mockResolvedValue({
      signer: { getPublicKey: vi.fn(), signTransaction: vi.fn() },
      address: WALLET,
    } as never);
  });

  it("encodes and submits a valid Anchor call", async () => {
    const result = await callSolanaProgramCore(validInput);

    expect(result).toMatchObject({
      success: true,
      transactionHash: "mock-signature",
      transactionLink: "https://solscan.io/tx/mock-signature",
      gasUsedUnits: "4521",
      effectiveGasPrice: "10",
      instruction: "do_thing",
    });
    expect(mockAdapter.sendTransaction).toHaveBeenCalledTimes(1);
    const options = mockAdapter.sendTransaction.mock.calls[0][3];
    expect(options.gasOverrides).toEqual({});
  });

  it("rejects when maxSol is missing", async () => {
    const { maxSol: _maxSol, ...withoutMaxSol } = validInput;
    const result = await callSolanaProgramCore(withoutMaxSol);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("maxSol is required"),
    });
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects a non-Solana network without touching the adapter", async () => {
    const result = await callSolanaProgramCore({
      ...validInput,
      network: "ethereum",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "only supported on Solana networks"
    );
    expect(getChainAdapter).not.toHaveBeenCalled();
  });

  it("rejects an invalid program id", async () => {
    const result = await callSolanaProgramCore({
      ...validInput,
      programId: "not-a-program!!",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Invalid Solana program address"
    );
  });

  it("rejects an IDL that is not valid JSON", async () => {
    const result = await callSolanaProgramCore({ ...validInput, idl: "{bad" });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("not valid JSON");
  });

  it("surfaces an encoding error (unknown instruction)", async () => {
    const result = await callSolanaProgramCore({
      ...validInput,
      instruction: "missing",
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("not found in IDL");
    expect(mockAdapter.sendTransaction).not.toHaveBeenCalled();
  });

  it("requires an execution or organization context", async () => {
    const result = await callSolanaProgramCore({
      ...validInput,
      _context: undefined,
    });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Execution ID or organization ID is required"
    );
  });
});
