import "dotenv/config";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * disburseCore against real Solana devnet and a real Postgres run ledger.
 *
 * Boundaries swapped the same way transfer-spl-token-devnet.test.ts does: the
 * org wallet is a local funded keypair (via SolanaKeypairSigner, the same
 * interface Turnkey implements) and the adapter is a real devnet
 * SolanaChainAdapter. The ledger is real disbursementLegs rows.
 *
 * This is the resume guarantee against a real chain and a real database,
 * complementing the Base Sepolia ERC-20 on-chain reproduction cited in the
 * originating issue: two legs, a fresh mint, both sent, then the same run key
 * re-run to prove the second run skips both legs and broadcasts nothing.
 *
 * Gated on SOLANA_DEVNET_TEST_KEYPAIR (a funded devnet keypair, Solana CLI
 * JSON byte-array format) AND DATABASE_URL, so CI stays offline unless both
 * are provided.
 */

const holder = vi.hoisted(() => ({
  senderBytes: [] as number[],
  senderAddress: "",
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn(async () => ({
    success: true,
    organizationId: "disburse-devnet-test",
    userId: "disburse-devnet-test",
  })),
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: vi.fn(async () => ({ kind: "eoa" })),
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

const GATED = Boolean(
  process.env.SOLANA_DEVNET_TEST_KEYPAIR && process.env.DATABASE_URL
);

describe.skipIf(!GATED)("disburseCore live devnet resume", () => {
  it("pays two SPL legs then skips both on a repeat run with the same run key", async () => {
    const {
      createMint,
      getAccount,
      getAssociatedTokenAddressSync,
      getOrCreateAssociatedTokenAccount,
      mintTo,
      TOKEN_PROGRAM_ID,
    } = await import("@solana/spl-token");
    const { Connection, Keypair } = await import("@solana/web3.js");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { disbursementLegs } = await import("@/lib/db/schema");
    const { disburseCore } = await import("@/plugins/web3/steps/disburse-core");

    const DECIMALS = 6;
    const ONE_TOKEN = BigInt(10 ** DECIMALS);
    const DEVNET = "https://api.devnet.solana.com";
    const ORG = "disburse-devnet-test";
    const RUN_KEY = `disburse-devnet-${Date.now()}`;

    const connection = new Connection(DEVNET, "confirmed");
    const sender = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(process.env.SOLANA_DEVNET_TEST_KEYPAIR as string)
      )
    );
    holder.senderBytes = Array.from(sender.secretKey);
    holder.senderAddress = sender.publicKey.toBase58();

    const mint = await createMint(
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

    const recipientA = Keypair.generate().publicKey;
    const recipientB = Keypair.generate().publicKey;
    const legs = [
      { recipient: recipientA.toBase58(), amount: "1" },
      { recipient: recipientB.toBase58(), amount: "2" },
    ];

    const first = await disburseCore({
      network: "solana-devnet",
      assetType: "spl",
      mint: mint.toBase58(),
      runKey: RUN_KEY,
      legs,
      _context: {
        organizationId: ORG,
        nodeId: "disburse-1",
        nodeName: "Disburse",
        nodeType: "web3/disburse",
      },
    });

    if (!first.success) {
      throw new Error(
        `disburse failed: ${first.error}\n${JSON.stringify(first.results, null, 2)}`
      );
    }
    expect(first.results.map((r) => r.status)).toEqual(["paid", "paid"]);
    console.log(
      `\nDisburse landed on devnet, run key ${RUN_KEY}:\n` +
        first.results
          .map(
            (r) =>
              `  leg ${r.index} -> https://solscan.io/tx/${r.transactionHash}?cluster=devnet`
          )
          .join("\n") +
        "\n"
    );

    for (const [recipient, amount] of [
      [recipientA, ONE_TOKEN],
      [recipientB, ONE_TOKEN * BigInt(2)],
    ] as const) {
      const ata = getAssociatedTokenAddressSync(
        mint,
        recipient,
        true,
        TOKEN_PROGRAM_ID
      );
      const account = await getAccount(
        connection,
        ata,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      expect(account.amount).toBe(amount);
    }

    // The re-run: same run key, same legs, nothing sent.
    const second = await disburseCore({
      network: "solana-devnet",
      assetType: "spl",
      mint: mint.toBase58(),
      runKey: RUN_KEY,
      legs,
      _context: {
        organizationId: ORG,
        nodeId: "disburse-1",
        nodeName: "Disburse",
        nodeType: "web3/disburse",
      },
    });

    expect(second.success).toBe(true);
    if (!second.success) {
      throw new Error(`unreachable: ${second.error}`);
    }
    expect(second.results.map((r) => r.status)).toEqual([
      "already_paid",
      "already_paid",
    ]);
    expect(second.legTransactions).toEqual([]);
    expect(second.results[0].transactionHash).toBe(
      first.results[0].transactionHash
    );
    expect(second.results[1].transactionHash).toBe(
      first.results[1].transactionHash
    );

    await db
      .delete(disbursementLegs)
      .where(eq(disbursementLegs.runKey, RUN_KEY));
  }, 180_000);
});
