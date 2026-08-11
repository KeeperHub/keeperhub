import "dotenv/config";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { Keypair } from "@solana/web3.js";
import { getSolanaProviderFromUrls } from "@/lib/rpc/provider-factory";
import { PUBLIC_RPCS } from "@/lib/rpc/rpc-config";
import { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import { SolanaKeypairSigner } from "@/lib/web3/solana-signer";

describe.skipIf(!process.env.SOLANA_DEVNET_TEST_KEYPAIR)(
  "SolanaChainAdapter write integration",
  () => {
    it("performs a live native SOL transfer on devnet and maps TransactionReceipt fields", async () => {
      // Set up connection factory
      const adapter = new SolanaChainAdapter(103, () =>
        getSolanaProviderFromUrls(
          PUBLIC_RPCS.SOLANA_DEVNET,
          undefined,
          "Solana Devnet"
        )
      );

      // Load test keypair from env
      let keypairBytes: number[];
      try {
        const rawKeypair = process.env.SOLANA_DEVNET_TEST_KEYPAIR;
        if (!rawKeypair) {
          throw new Error(
            "SOLANA_DEVNET_TEST_KEYPAIR environment variable is missing"
          );
        }
        keypairBytes = JSON.parse(rawKeypair);
      } catch (err) {
        throw new Error(
          "Failed to parse SOLANA_DEVNET_TEST_KEYPAIR as JSON array: " +
            String(err)
        );
      }

      const senderKeypair = Keypair.fromSecretKey(
        Uint8Array.from(keypairBytes)
      );
      const solanaSigner = new SolanaKeypairSigner(senderKeypair);
      const recipient = Keypair.generate().publicKey;

      // Fetch balances before
      const senderBalBefore = await adapter.getBalance(
        null as any,
        senderKeypair.publicKey.toBase58()
      );
      const recipientBalBefore = await adapter.getBalance(
        null as any,
        recipient.toBase58()
      );

      // Perform tiny transfer — must exceed rent-exempt minimum (~890,880 lamports)
      // for the freshly-generated recipient account to be created on-chain.
      const receipt = await adapter.sendTransaction(
        null as any,
        {
          to: recipient.toBase58(),
          value: BigInt(1_000_000),
        },
        null as any,
        {
          solanaSigner,
          gasOverrides: {
            priorityFeeOverride: BigInt(10),
          },
        } as any
      );

      // Assertions
      expect(receipt.hash).toBeDefined();
      // Base58 matches length check
      expect(receipt.hash.length).toBeGreaterThanOrEqual(44);
      expect(receipt.gasUsed).toBeGreaterThan(BigInt(0));
      expect(receipt.effectiveGasPrice).toBe(BigInt(10));
      expect(receipt.blockNumber).toBeGreaterThan(0);

      // Verify balances after
      const senderBalAfter = await adapter.getBalance(
        null as any,
        senderKeypair.publicKey.toBase58()
      );
      const recipientBalAfter = await adapter.getBalance(
        null as any,
        recipient.toBase58()
      );

      expect(recipientBalAfter).toBe(recipientBalBefore + BigInt(1_000_000));
      expect(senderBalAfter).toBeLessThan(senderBalBefore);
    }, 30_000);
  }
);
