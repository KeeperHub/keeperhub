import "server-only";
import { PublicKey } from "@solana/web3.js";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import { PolicyBlockedError, TurnkeyUpstreamError } from "./sign";

type TurnkeySignTransactionResult = {
  signedTransaction?: string;
};

type TurnkeyActivityResponse = {
  activity?: {
    status?: string;
    result?: { signTransactionResult?: TurnkeySignTransactionResult };
  };
};

export class TurnkeySolanaSigner implements SolanaTransactionSigner {
  constructor(
    private readonly subOrgId: string,
    private readonly solanaAddress: string // base58 public key
  ) {}

  async getPublicKey(): Promise<{ toBase58(): string }> {
    return new PublicKey(this.solanaAddress);
  }

  async signTransaction(unsignedBytes: Uint8Array): Promise<Uint8Array> {
    const unsignedTransaction = Buffer.from(unsignedBytes).toString("base64");
    const client = getTurnkeyClientForOrg(this.subOrgId).apiClient();

    const activity = (await (
      client as unknown as {
        signTransaction: (args: unknown) => Promise<TurnkeyActivityResponse>;
      }
    ).signTransaction({
      signWith: this.solanaAddress,
      type: "TRANSACTION_TYPE_SOLANA",
      unsignedTransaction,
    })) as TurnkeyActivityResponse;

    const status = activity.activity?.status;
    if (status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
      throw new PolicyBlockedError(
        "Turnkey policy blocked the Solana signing activity (CONSENSUS_NEEDED)"
      );
    }
    if (status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new TurnkeyUpstreamError(
        `Turnkey returned status ${status ?? "unknown"} for Solana signTransaction`
      );
    }
    const signed =
      activity.activity?.result?.signTransactionResult?.signedTransaction;
    if (!signed) {
      throw new TurnkeyUpstreamError(
        "signedTransaction missing from Turnkey Solana response"
      );
    }
    // Turnkey returns base64; decode to Uint8Array
    return Uint8Array.from(Buffer.from(signed, "base64"));
  }
}
