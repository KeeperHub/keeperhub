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
  PublicKey,
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
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
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

  describe("on-chain failure handling", () => {
    it("throws when confirmTransaction reports an execution error", async () => {
      const { mockManager, mockConnection } = createMockManager();
      mockConnection.confirmTransaction = vi.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, "Custom"] } },
      });
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      await expect(
        adapter.sendTransaction(
          null as any,
          { to: recipientKeypair.publicKey.toBase58(), value: BigInt(5000) },
          null as any,
          { solanaSigner, gasOverrides: {} } as any
        )
      ).rejects.toThrow("failed on-chain");
    });

    it("throws when getTransaction reports meta.err (reverted at inclusion)", async () => {
      const { mockManager, mockConnection } = createMockManager();
      mockConnection.getTransaction = vi.fn().mockResolvedValue({
        slot: 789,
        meta: {
          err: { InstructionError: [0, "Custom"] },
          computeUnitsConsumed: 10,
        },
      });
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
        Promise.resolve(mockManager as any)
      );

      await expect(
        adapter.sendTransaction(
          null as any,
          { to: recipientKeypair.publicKey.toBase58(), value: BigInt(5000) },
          null as any,
          { solanaSigner, gasOverrides: {} } as any
        )
      ).rejects.toThrow("reverted on-chain");
    });
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

    it("retries once with a fresh blockhash when submit fails with blockhash expiry", async () => {
      const { mockManager, mockConnection } = createMockManager();
      let sendRawCallCount = 0;
      mockConnection.sendRawTransaction = vi.fn().mockImplementation(() => {
        sendRawCallCount++;
        if (sendRawCallCount === 1) {
          return Promise.reject(new Error("BlockhashNotFound"));
        }
        return Promise.resolve("signature123");
      });
      // The first attempt never landed and the chain has moved past the block
      // height its blockhash was valid for, so it can never land: re-signing is
      // safe only once that is established.
      mockConnection.getSignatureStatuses = vi
        .fn()
        .mockResolvedValue({ value: [null] });
      (mockConnection as any).getBlockHeight = vi
        .fn()
        .mockResolvedValue(200_000);

      const originalSignTransaction =
        solanaSigner.signTransaction.bind(solanaSigner);
      const signTransactionSpy = vi
        .fn()
        .mockImplementation(originalSignTransaction);
      solanaSigner.signTransaction = signTransactionSpy;

      const adapter = new SolanaChainAdapter(
        DEVNET_CHAIN_ID,
        () => Promise.resolve(mockManager as any),
        { timeoutMs: 500, pollMs: 10, reconcileDelayMs: 0 }
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
          gasOverrides: {},
        } as any
      );

      expect(receipt.hash).toBe("signature123");
      expect(signTransactionSpy).toHaveBeenCalledTimes(2);
      expect(mockConnection.getLatestBlockhash).toHaveBeenCalledTimes(2);
      expect(sendRawCallCount).toBe(2);
    });

    it("adopts the first transaction rather than re-signing when it confirms", async () => {
      // The broadcast reported a blockhash error but the transaction was live
      // and confirmed. Re-signing here would put a second transaction on chain
      // with its own signature - Solana dedupes by signature, so both would
      // execute and the transfer would happen twice.
      const { mockManager, mockConnection } = createMockManager();
      let sendRawCallCount = 0;
      mockConnection.sendRawTransaction = vi.fn().mockImplementation(() => {
        sendRawCallCount++;
        return Promise.reject(new Error("BlockhashNotFound"));
      });
      // Invisible while submit reconciles, surfacing only once the expiry
      // proof is waiting on it - the window in which the old code had already
      // given up and re-signed.
      let statusCalls = 0;
      mockConnection.getSignatureStatuses = vi.fn().mockImplementation(() => {
        statusCalls++;
        return Promise.resolve({
          value: [statusCalls > 5 ? { confirmationStatus: "confirmed" } : null],
        });
      });
      // Still inside the blockhash's valid window, so nothing has expired.
      (mockConnection as any).getBlockHeight = vi.fn().mockResolvedValue(1);

      const signTransactionSpy = vi
        .fn()
        .mockImplementation(solanaSigner.signTransaction.bind(solanaSigner));
      solanaSigner.signTransaction = signTransactionSpy;

      const adapter = new SolanaChainAdapter(
        DEVNET_CHAIN_ID,
        () => Promise.resolve(mockManager as any),
        { timeoutMs: 500, pollMs: 10, reconcileDelayMs: 0 }
      );

      const receipt = await adapter.sendTransaction(
        null as any,
        { to: recipientKeypair.publicKey.toBase58(), value: BigInt(5000) },
        null as any,
        { solanaSigner, gasOverrides: {} } as any
      );

      // Signed and broadcast exactly once; the confirmed signature is adopted.
      expect(signTransactionSpy).toHaveBeenCalledTimes(1);
      expect(sendRawCallCount).toBe(1);
      expect(receipt.hash).toBeDefined();
    });

    it("refuses to re-sign while the first transaction may still land", async () => {
      // Neither confirmed nor provably dead: the blockhash is still within its
      // valid window, so the transaction could yet be included. Failing the
      // execution is the conservative outcome - re-signing is the one that can
      // spend twice.
      const { mockManager, mockConnection } = createMockManager();
      let sendRawCallCount = 0;
      mockConnection.sendRawTransaction = vi.fn().mockImplementation(() => {
        sendRawCallCount++;
        return Promise.reject(new Error("BlockhashNotFound"));
      });
      mockConnection.getSignatureStatuses = vi
        .fn()
        .mockResolvedValue({ value: [null] });
      (mockConnection as any).getBlockHeight = vi.fn().mockResolvedValue(1);

      const signTransactionSpy = vi
        .fn()
        .mockImplementation(solanaSigner.signTransaction.bind(solanaSigner));
      solanaSigner.signTransaction = signTransactionSpy;

      const adapter = new SolanaChainAdapter(
        DEVNET_CHAIN_ID,
        () => Promise.resolve(mockManager as any),
        { timeoutMs: 50, pollMs: 10, reconcileDelayMs: 0 }
      );

      await expect(
        adapter.sendTransaction(
          null as any,
          { to: recipientKeypair.publicKey.toBase58(), value: BigInt(5000) },
          null as any,
          { solanaSigner, gasOverrides: {} } as any
        )
      ).rejects.toThrow(/refusing to re-sign/);

      expect(signTransactionSpy).toHaveBeenCalledTimes(1);
      expect(sendRawCallCount).toBe(1);
    });

    it("prevents double-spend by signing and broadcasting exactly once even when confirmation retries", async () => {
      const { mockConnection } = createMockManager();

      // Track arguments passed to signTransaction
      const originalSignTransaction =
        solanaSigner.signTransaction.bind(solanaSigner);
      const signTransactionSpy = vi
        .fn()
        .mockImplementation(originalSignTransaction);
      solanaSigner.signTransaction = signTransactionSpy;

      // Mock confirmTransaction to fail first time, then succeed
      let confirmCallCount = 0;
      mockConnection.confirmTransaction = vi.fn().mockImplementation(() => {
        confirmCallCount++;
        if (confirmCallCount === 1) {
          throw new Error("Transient read-side RPC connection timeout");
        }
        return Promise.resolve({ value: { err: null } });
      });

      // Implement a mock executeWithFailover that actually retries on error
      const mockManager = {
        executeWithFailover: vi.fn().mockImplementation(async (op) => {
          try {
            return await op(mockConnection as any);
          } catch {
            // Retry exactly once on error
            return await op(mockConnection as any);
          }
        }),
      };

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
            priorityFeeOverride: BigInt(100),
          },
        } as any
      );

      // Assertions
      expect(receipt.hash).toBe("signature123");

      // confirmTransaction must be called twice (failed first, succeeded second)
      expect(confirmCallCount).toBe(2);

      // signTransaction must be called exactly once
      expect(signTransactionSpy).toHaveBeenCalledTimes(1);

      // sendRawTransaction must be called exactly once (no retry on broadcast side)
      expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
  });
});

describe("SolanaChainAdapter - maxSol enforcement", () => {
  let signerKeypair: Keypair;
  let solanaSigner: SolanaKeypairSigner;
  let recipientKeypair: Keypair;

  const PRE_BALANCE = 10_000_000;

  /**
   * Mirrors buildSerializedSolanaInstructionTx: the instruction-based Solana
   * actions that require maxSol hand the adapter a serialized LEGACY
   * transaction. Legacy bytes still deserialize into a VersionedTransaction
   * (wrapping a legacy Message) rather than throwing, so these reach the
   * adapter's versioned branch - which is why that branch has to be the one
   * that requests the fee payer's simulated state.
   */
  function buildLegacySerializedTx(): string {
    const transaction = new Transaction();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: signerKeypair.publicKey,
        toPubkey: recipientKeypair.publicKey,
        lamports: 1000,
      })
    );
    transaction.feePayer = signerKeypair.publicKey;
    transaction.recentBlockhash = PublicKey.default.toBase58();
    return transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }

  /**
   * Models the RPC contract rather than returning account state
   * unconditionally: simulateTransaction reports accounts only when the caller
   * asked for them, and reports them in the order requested. A mock that hands
   * back accounts regardless cannot distinguish a correct request from an
   * omitted one, which is precisely the defect under test.
   */
  function createMaxSolManager(postLamports: number | null) {
    const { mockManager, mockConnection } = createMockManager();
    (mockConnection as any).getBalance = vi.fn().mockResolvedValue(PRE_BALANCE);
    mockConnection.simulateTransaction = vi
      .fn()
      .mockImplementation(
        (_tx: unknown, configOrSigners: any, includeAccounts?: unknown) => {
          let requested: string[] | undefined;
          if (configOrSigners?.accounts?.addresses) {
            requested = configOrSigners.accounts.addresses;
          } else if (Array.isArray(includeAccounts)) {
            requested = (includeAccounts as PublicKey[]).map((key) =>
              key.toBase58()
            );
          }

          const accounts = requested?.map((address) =>
            address === signerKeypair.publicKey.toBase58() &&
            postLamports !== null
              ? { lamports: postLamports }
              : null
          );

          return Promise.resolve({ value: { err: null, logs: [], accounts } });
        }
      );
    return { mockManager, mockConnection };
  }

  function send(mockManager: unknown, maxSolLamports: bigint) {
    const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
      Promise.resolve(mockManager as any)
    );
    return adapter.sendTransaction(
      null as any,
      {
        to: signerKeypair.publicKey.toBase58(),
        data: buildLegacySerializedTx(),
      },
      null as any,
      { solanaSigner, gasOverrides: {}, maxSolLamports } as any
    );
  }

  beforeEach(() => {
    signerKeypair = Keypair.generate();
    solanaSigner = new SolanaKeypairSigner(signerKeypair);
    recipientKeypair = Keypair.generate();
    vi.clearAllMocks();
  });

  it("requests the fee payer's simulated state by address", async () => {
    const { mockManager, mockConnection } = createMaxSolManager(
      PRE_BALANCE - 500_000
    );

    await send(mockManager, BigInt(1_000_000));

    // Without an explicit accounts request the simulation returns no account
    // state at all and the check below can never run.
    const config = mockConnection.simulateTransaction.mock.calls[0][1];
    expect(config.accounts.addresses).toEqual([
      signerKeypair.publicKey.toBase58(),
    ]);
  });

  it("allows an outflow within the declared ceiling", async () => {
    const { mockManager } = createMaxSolManager(PRE_BALANCE - 500_000);

    const receipt = await send(mockManager, BigInt(1_000_000));

    expect(receipt.hash).toBe("signature123");
  });

  it("rejects an outflow above the declared ceiling", async () => {
    const { mockManager } = createMaxSolManager(PRE_BALANCE - 2_000_000);

    await expect(send(mockManager, BigInt(1_000_000))).rejects.toThrow(
      /exceeding declared maxSol ceiling/
    );
  });

  it("fails closed when the simulation returns no fee payer state", async () => {
    const { mockManager } = createMaxSolManager(null);

    await expect(send(mockManager, BigInt(1_000_000))).rejects.toThrow(
      /did not return fee payer account state/
    );
  });

  it("does not request account state when no ceiling is declared", async () => {
    const { mockManager, mockConnection } = createMaxSolManager(null);
    const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
      Promise.resolve(mockManager as any)
    );

    await adapter.sendTransaction(
      null as any,
      {
        to: signerKeypair.publicKey.toBase58(),
        data: buildLegacySerializedTx(),
      },
      null as any,
      { solanaSigner, gasOverrides: {} } as any
    );

    const config = mockConnection.simulateTransaction.mock.calls[0][1];
    expect(config.accounts).toBeUndefined();
    expect((mockConnection as any).getBalance).not.toHaveBeenCalled();
  });
});
