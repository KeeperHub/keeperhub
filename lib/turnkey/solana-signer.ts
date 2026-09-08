import "server-only";

import { PublicKey } from "@solana/web3.js";
import {
  PolicyBlockedError,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign";
import {
  runTurnkeyActivity,
  type TurnkeyActivityErrorSpec,
  type TurnkeySignTransactionActivityResult,
} from "@/lib/turnkey/activity";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";

const SIGN_ACTIVITY_ERRORS: TurnkeyActivityErrorSpec = {
  policyBlockedError: PolicyBlockedError,
  upstreamError: TurnkeyUpstreamError,
  policyBlockedMessage:
    "Turnkey policy blocked the Solana signing activity (CONSENSUS_NEEDED)",
  statusMessageSuffix: " for Solana signTransaction",
  missingResultMessage:
    "signedTransaction missing from Turnkey Solana response",
};

export class TurnkeySolanaSigner implements SolanaTransactionSigner {
  private readonly subOrgId: string;
  private readonly solanaAddress: string;

  constructor(subOrgId: string, solanaAddress: string) {
    this.subOrgId = subOrgId;
    this.solanaAddress = solanaAddress;
  }

  getPublicKey(): Promise<{ toBase58(): string }> {
    return Promise.resolve(new PublicKey(this.solanaAddress));
  }

  async signTransaction(unsignedBytes: Uint8Array): Promise<Uint8Array> {
    const unsignedTransaction = Buffer.from(unsignedBytes).toString("hex");
    const client = getTurnkeyClientForOrg(this.subOrgId).apiClient();

    const signed = await runTurnkeyActivity<
      TurnkeySignTransactionActivityResult,
      string
    >(
      client,
      "signTransaction",
      {
        signWith: this.solanaAddress,
        type: "TRANSACTION_TYPE_SOLANA",
        unsignedTransaction,
      },
      (result) => result?.signTransactionResult?.signedTransaction,
      SIGN_ACTIVITY_ERRORS
    );
    return Uint8Array.from(Buffer.from(signed, "hex"));
  }
}
