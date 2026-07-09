import "server-only";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "VALIDATION" },
  logDebug: vi.fn(),
  logUserError: vi.fn(),
}));

import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import { SolanaKeypairSigner } from "@/lib/web3/solana-signer";

const DEVNET_CHAIN_ID = 103;

function createMockManager() {
  const mockConnection = {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      lastValidBlockHeight: 123_456,
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: [] },
    }),
    sendRawTransaction: vi.fn().mockResolvedValue("signature123"),
    confirmTransaction: vi.fn().mockResolvedValue({
      value: { err: null },
    }),
    getTransaction: vi.fn().mockResolvedValue({
      slot: 789,
      meta: {
        err: null,
        computeUnitsConsumed: 15_000,
        fee: 5000,
      },
    }),
  };

  const mockManager = {
    executeWithFailover: vi.fn().mockImplementation((op) => op(mockConnection)),
  };

  return { mockManager, mockConnection };
}

describe("SolanaChainAdapter - sendTransaction", () => {
  let signerKeypair: Keypair;
  let solanaSigner: SolanaKeypairSigner;
  let recipientKeypair: Keypair;

  beforeEach(() => {
    signerKeypair = Keypair.generate();
    solanaSigner = new SolanaKeypairSigner(signerKeypair);
    recipientKeypair = Keypair.generate();
    vi.clearAllMocks();
  });

  it("throws when solanaSigner is missing", async () => {
    const { mockManager } = createMockManager();
    const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
      Promise.resolve(mockManager as any)
    );

    await expect(
      adapter.sendTransaction(
        null as any,
        { to: recipientKeypair.publicKey.toBase58(), value: BigInt(1000) },
        null as any,
        {
          gasOverrides: {},
        } as any
      )
    ).rejects.toThrow("[SolanaChainAdapter] Missing options.solanaSigner");
  });

  describe("Mode B (Native transfer)", () => {
    it("successfully creates, simulates, signs, and processes native transfer", async () => {
      const { mockManager, mockConnection } = createMockManager();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      const receipt = await adapter.sendTransaction(
        null as any,
        {
          to: recipientKeypair.publicKey.toBase58(),
          value: BigInt(5000),
        },
        null as any,
        {
          solanaSigner,
          gasOverrides: {
            priorityFeeOverride: BigInt(123),
            gasLimitOverride: BigInt(456),
          },
        } as any
      );

      // Verify receipt structure
      expect(receipt.hash).toBeDefined();
      expect(receipt.gasUsed).toBe(BigInt(15_000));
      expect(receipt.effectiveGasPrice).toBe(BigInt(123));
      expect(receipt.blockNumber).toBe(789);

      // Verify connection simulation calls
      expect(mockConnection.simulateTransaction).toHaveBeenCalledTimes(1);
      expect(mockConnection.getLatestBlockhash).toHaveBeenCalledTimes(1);
    });

    it("throws if recipient is invalid", async () => {
      const { mockManager } = createMockManager();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      await expect(
        adapter.sendTransaction(
          null as any,
          {
            to: "invalid-pubkey",
            value: BigInt(5000),
          },
          null as any,
          {
            solanaSigner,
            gasOverrides: {},
          } as any
        )
      ).rejects.toThrow("Invalid recipient 'to' address");
    });

    it("throws if gasLimitOverride is out of bounds", async () => {
      const { mockManager } = createMockManager();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      await expect(
        adapter.sendTransaction(
          null as any,
          {
            to: recipientKeypair.publicKey.toBase58(),
            value: BigInt(5000),
          },
          null as any,
          {
            solanaSigner,
            gasOverrides: {
              gasLimitOverride: BigInt(2_000_000),
            },
          } as any
        )
      ).rejects.toThrow(
        "Compute unit limit override out of bounds (1 - 1,400,000)"
      );
    });

    it("uses 0n default for value if omitted", async () => {
      const { mockManager } = createMockManager();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      const receipt = await adapter.sendTransaction(
        null as any,
        {
          to: recipientKeypair.publicKey.toBase58(),
        },
        null as any,
        {
          solanaSigner,
          gasOverrides: {},
        } as any
      );

      expect(receipt.hash).toBeDefined();
    });

    it("falls back to 0n gasUsed when computeUnitsConsumed is null", async () => {
      const { mockManager, mockConnection } = createMockManager();
      mockConnection.getTransaction.mockResolvedValue({
        slot: 789,
        meta: {
          err: null,
          computeUnitsConsumed: null,
          fee: 5000,
        },
      } as any);

      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      const receipt = await adapter.sendTransaction(
        null as any,
        {
          to: recipientKeypair.publicKey.toBase58(),
        },
        null as any,
        {
          solanaSigner,
          gasOverrides: {},
        } as any
      );

      expect(receipt.gasUsed).toBe(BigInt(0));
    });
  });

  describe("Mode A (Data Present)", () => {
    it("successfully decompiles and prepends overrides on legacy Transaction", async () => {
      const { mockManager, mockConnection } = createMockManager();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      // Build a simple legacy transaction
      const rawTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: signerKeypair.publicKey,
          toPubkey: recipientKeypair.publicKey,
          lamports: BigInt(1000),
        })
      );
      rawTx.feePayer = signerKeypair.publicKey;
      rawTx.recentBlockhash = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

      const serialized = rawTx
        .serialize({ requireAllSignatures: false })
        .toString("base64");

      const receipt = await adapter.sendTransaction(
        null as any,
        {
          to: "",
          data: serialized,
        },
        null as any,
        {
          solanaSigner,
          gasOverrides: {
            priorityFeeOverride: BigInt(99),
          },
        } as any
      );

      expect(receipt.effectiveGasPrice).toBe(BigInt(99));
      expect(mockConnection.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it("throws error when VersionedTransaction contains ALTs and overrides are requested", async () => {
      const { mockManager } = createMockManager();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      // Build a valid VersionedTransaction using TransactionMessage.compileToV0Message
      const { TransactionMessage, SystemProgram } = await import(
        "@solana/web3.js"
      );
      const message = new TransactionMessage({
        payerKey: signerKeypair.publicKey,
        recentBlockhash: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        instructions: [
          SystemProgram.transfer({
            fromPubkey: signerKeypair.publicKey,
            toPubkey: recipientKeypair.publicKey,
            lamports: BigInt(1000),
          }),
        ],
      });

      const v0Message = message.compileToV0Message();

      // Patch addressTableLookups to simulate ALTs being present on the message
      (v0Message as any).addressTableLookups = [
        {
          accountKey: Keypair.generate().publicKey,
          writableIndexes: [0],
          readonlyIndexes: [],
        },
      ];

      const vTx = new VersionedTransaction(v0Message);
      const serialized = Buffer.from(vTx.serialize()).toString("base64");

      await expect(
        adapter.sendTransaction(
          null as any,
          {
            to: "",
            data: serialized,
          },
          null as any,
          {
            solanaSigner,
            gasOverrides: {
              priorityFeeOverride: BigInt(100),
            },
          } as any
        )
      ).rejects.toThrow(
        "Overrides not supported on VersionedTransaction containing Address Lookup Tables (ALTs)"
      );
    });

    it("skips budget injection if ComputeBudgetProgram instructions are already present", async () => {
      const { mockManager } = createMockManager();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      const rawTx = new Transaction()
        .add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: BigInt(10),
          })
        )
        .add(
          SystemProgram.transfer({
            fromPubkey: signerKeypair.publicKey,
            toPubkey: recipientKeypair.publicKey,
            lamports: BigInt(1000),
          })
        );
      rawTx.feePayer = signerKeypair.publicKey;
      rawTx.recentBlockhash = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

      const serialized = rawTx
        .serialize({ requireAllSignatures: false })
        .toString("base64");

      const receipt = await adapter.sendTransaction(
        null as any,
        {
          to: "",
          data: serialized,
        },
        null as any,
        {
          solanaSigner,
          gasOverrides: {
            priorityFeeOverride: BigInt(99), // Should be ignored
          },
        } as any
      );

      // Verify that it preserves original priority fee (10)
      expect(receipt.effectiveGasPrice).toBe(BigInt(10));
    });
  });
});
