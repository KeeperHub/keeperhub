/**
 * Turnkey signTransaction primitive (ACTIVITY_TYPE_SIGN_TRANSACTION_V2) + a
 * thin viem broadcast helper.
 *
 * Sibling to ./sign.ts which proxies signRawPayload for x402/MPP USDC EIP-712
 * payment challenges. This module is the path for raw EVM tx signing on
 * Ethereum mainnet (the ERC-8004 ReputationRegistry::giveFeedback flow).
 *
 * Both files share the same Turnkey client factory (getTurnkeyClientForOrg)
 * and the same PolicyBlockedError / TurnkeyUpstreamError surface so callers
 * see a uniform error contract.
 *
 * Policy contract (lib/agentic-wallet/policy.ts BASELINE_POLICIES):
 *   - allowlist-outbound-contracts: eth.tx.to in {USDC_BASE, USDC_TEMPO,
 *     ERC_8004_REPUTATION_REGISTRY}
 *   - allowlist-tx-chain-binding: each contract bound to its native chain id
 *     (USDC_BASE<->8453, USDC_TEMPO<->4217|4218, ReputationRegistry<->1)
 *   - allowlist-erc8004-selector: ReputationRegistry calls must invoke
 *     giveFeedback() (selector 0x3c036a7e)
 *
 * Anything else gets rejected by Turnkey with CONSENSUS_NEEDED -- we surface
 * that as PolicyBlockedError, never leaking the policy text upstream.
 */
import { createPublicClient, type Hex, http, parseTransaction } from "viem";
import { mainnet } from "viem/chains";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import { PolicyBlockedError, TurnkeyUpstreamError } from "./sign";

type TurnkeySignTransactionResult = {
  signedTransaction?: string;
};

type TurnkeyActivityResponse = {
  activity?: {
    status?: string;
    result?: {
      signTransactionResult?: TurnkeySignTransactionResult;
    };
  };
};

/**
 * Sign a serialized EIP-1559 Ethereum transaction via Turnkey. The caller
 * is responsible for nonce + gas estimation + RLP serialization (typically
 * via viem's `serializeTransaction({...})` with no `r/s/v`).
 *
 * Returns the fully-signed serialized tx hex (`0x...`), ready for
 * `eth_sendRawTransaction`.
 *
 * Throws:
 *   - PolicyBlockedError when Turnkey returns CONSENSUS_NEEDED. The caller's
 *     unsigned tx violated one of the BASELINE_POLICIES gates above.
 *   - TurnkeyUpstreamError on transport failures or COMPLETED status with a
 *     missing signedTransaction (rare but documented).
 */
export async function signEthereumTransaction(args: {
  subOrgId: string;
  walletAddress: `0x${string}`;
  /** RLP-encoded unsigned tx hex; MUST NOT include the 0x prefix. */
  unsignedTransactionHex: string;
}): Promise<{ signedTransaction: `0x${string}` }> {
  const { subOrgId, walletAddress, unsignedTransactionHex } = args;
  const client = getTurnkeyClientForOrg(subOrgId).apiClient();
  const activity = (await (
    client as unknown as {
      signTransaction: (args: unknown) => Promise<TurnkeyActivityResponse>;
    }
  ).signTransaction({
    signWith: walletAddress,
    type: "TRANSACTION_TYPE_ETHEREUM",
    unsignedTransaction: unsignedTransactionHex,
  })) as TurnkeyActivityResponse;

  const status = activity.activity?.status;
  if (status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
    throw new PolicyBlockedError(
      "Turnkey policy blocked the activity (CONSENSUS_NEEDED)"
    );
  }
  if (status !== "ACTIVITY_STATUS_COMPLETED") {
    throw new TurnkeyUpstreamError(
      `Turnkey returned status ${status ?? "unknown"}`
    );
  }
  const signed =
    activity.activity?.result?.signTransactionResult?.signedTransaction;
  if (!signed) {
    throw new TurnkeyUpstreamError(
      "signedTransaction missing from Turnkey response"
    );
  }
  const prefixed = signed.startsWith("0x") ? signed : `0x${signed}`;
  return { signedTransaction: prefixed as `0x${string}` };
}

/**
 * Broadcast a signed serialized tx via the chain's configured RPC. Returns
 * the canonical tx hash. Verifies the parsed transaction's chain id matches
 * the requested chain id before broadcast as a defence-in-depth gate against
 * a Turnkey policy regression silently signing on the wrong chain.
 */
export async function broadcastSignedTransaction(args: {
  signedTransaction: Hex;
  chainId: number;
}): Promise<{ txHash: Hex }> {
  const { signedTransaction, chainId } = args;
  const parsed = parseTransaction(signedTransaction);
  if (parsed.chainId !== chainId) {
    throw new Error(
      `Signed tx chainId ${parsed.chainId} does not match requested chainId ${chainId}`
    );
  }
  // getRpcUrlByChainId throws on unknown chain id; that maps to our existing
  // contract (No RPC configured for chainId X).
  const rpcUrl = getRpcUrlByChainId(chainId);
  // Mainnet only today; if/when we sign on more chains, extend the chain
  // selection here. viem's mainnet chain is sufficient for serialization
  // checks regardless of the actual chain since we only need the transport.
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
  const txHash = await client.sendRawTransaction({
    serializedTransaction: signedTransaction,
  });
  return { txHash };
}
