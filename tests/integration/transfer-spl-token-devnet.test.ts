import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";

// Boundaries swapped so the real transferSplTokenCore runs against live devnet:
// the org wallet is a local keypair (via SolanaKeypairSigner, the same interface
// Turnkey implements) and the adapter is a real devnet SolanaChainAdapter.
// Everything KEEP-984 adds - mint read, program detection, ATA derivation,
// transferChecked, serialization, and the adapter submit path - is exercised.
const holder = vi.hoisted(() => ({
  senderBytes: [] as number[],
  senderAddress: "",
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn(async () => ({
    success: true,
    organizationId: "devnet-test",
    userId: "devnet-test",
  })),
}));

vi.mock("@/lib/web3/wallet-helpers", async () => {
  const { SolanaKeypairSigner } = await import("@/lib/web3/solana-signer");
  const { Keypair: Kp } = await import("@solana/web3.js");
  return {
    initializeSolanaWallet: vi.fn(async () => ({
      signer: new SolanaKeypairSigner(
        Kp.fromSecretKey(Uint8Array.from(holder.senderBytes))
      ),
      address: holder.senderAddress,
    })),
  };
});

vi.mock("@/lib/web3/chain-adapter", async () => {
  const { SolanaChainAdapter } = await import(
    "@/lib/web3/chain-adapter/solana"
  );
  const { getSolanaProviderFromUrls } = await import(
    "@/lib/rpc/provider-factory"
  );
  const { PUBLIC_RPCS } = await import("@/lib/rpc/rpc-config");
  return {
    getChainAdapter: vi.fn(
      () =>
        new SolanaChainAdapter(103, () =>
          getSolanaProviderFromUrls(
            PUBLIC_RPCS.SOLANA_DEVNET,
            undefined,
            "Solana Devnet"
          )
        )
    ),
  };
});

import { transferSplTokenCore } from "@/plugins/web3/steps/transfer-spl-token-core";

const DEVNET = "https://api.devnet.solana.com";
const DECIMALS = 6;
const ONE_TOKEN = BigInt(10 ** DECIMALS);

// A live devnet transfer needs a funded keypair; skipped otherwise so CI stays
// offline. Provide it as a JSON byte array (Solana CLI format).
describe.skipIf(!process.env.SOLANA_DEVNET_TEST_KEYPAIR)(
  "transferSplTokenCore live devnet",
  () => {
    let connection: Connection;
    let sender: Keypair;
    let mint: PublicKey;
    let recipient: PublicKey;

    beforeAll(async () => {
      connection = new Connection(DEVNET, "confirmed");
      sender = Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(process.env.SOLANA_DEVNET_TEST_KEYPAIR as string)
        )
      );
      holder.senderBytes = Array.from(sender.secretKey);
      holder.senderAddress = sender.publicKey.toBase58();

      // Fresh mint (sender is authority) + a starting balance in the sender's ATA.
      mint = await createMint(
        connection,
        sender,
        sender.publicKey,
        null,
        DECIMALS,
        undefined,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );
      const senderAta = await getOrCreateAssociatedTokenAccount(
        connection,
        sender,
        mint,
        sender.publicKey,
        false,
        "confirmed",
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        sender,
        mint,
        senderAta.address,
        sender,
        ONE_TOKEN * BigInt(5),
        [],
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );

      // Fresh recipient - exercises recipient-ATA creation on the transfer.
      recipient = Keypair.generate().publicKey;
    }, 120_000);

    it("transfers an SPL token to a fresh recipient and lands it on-chain", async () => {
      const result = await transferSplTokenCore({
        network: "solana-devnet",
        mint: mint.toBase58(),
        recipientAddress: recipient.toBase58(),
        amount: "1",
        _context: { organizationId: "devnet-test" },
      });

      if (!result.success) {
        throw new Error(`transfer failed: ${result.error}`);
      }
      console.log(
        `\nSPL transfer landed: https://solscan.io/tx/${result.transactionHash}?cluster=devnet\n` +
          `  mint ${result.mint}\n  recipient ${result.recipient}\n  recipient ATA ${result.recipientTokenAccount}\n`
      );
      expect(result.success).toBe(true);
      expect(result.createdRecipientAccount).toBe(true);
      expect(result.decimals).toBe(DECIMALS);
      expect(result.transactionHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);

      // Independent on-chain confirmation: the recipient ATA holds exactly 1 token.
      const recipientAta = getAssociatedTokenAddressSync(
        mint,
        recipient,
        true,
        TOKEN_PROGRAM_ID
      );
      const account = await getAccount(
        connection,
        recipientAta,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      expect(account.amount).toBe(ONE_TOKEN);
      expect(account.mint.toBase58()).toBe(mint.toBase58());
    }, 120_000);
  }
);
