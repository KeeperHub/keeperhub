/**
 * Agentic-wallet signing helpers.
 *
 * Two signers proxy Turnkey signRawPayload so the npm client never holds a
 * Turnkey API key:
 *
 *   signX402Challenge -- EIP-3009 TransferWithAuthorization on Base USDC
 *   (chainId 8453, verifyingContract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).
 *   Returns a 132-char 0x-prefixed 65-byte signature (v-parity +27 via
 *   @turnkey/ethers::serializeSignature) that x402 facilitators ecrecover
 *   back to the wallet address.
 *
 *   signMppProof -- EIP-712 "Proof" typed-data on Tempo (chainId 4217).
 *   Phase 33 scope is proof-mode only (CONTEXT Resolution #3); pull-mode
 *   raw-transaction signing is deferred to Phase 34.
 *
 * Both call Turnkey with PAYLOAD_ENCODING_EIP712 + HASH_FUNCTION_NO_OP --
 * Turnkey hashes the typed-data internally when encoding is EIP712, but the
 * hashFunction field is still required and MUST be NO_OP (RESEARCH Pitfall in
 * Anti-Patterns section).
 *
 * On ACTIVITY_STATUS_CONSENSUS_NEEDED both helpers throw PolicyBlockedError so
 * the /sign route can translate to HTTP 403 POLICY_BLOCKED. Any other non-
 * COMPLETED status or missing result throws TurnkeyUpstreamError for 502.
 *
 * T-33-02 (Information Disclosure): this module never logs secrets, challenge
 * bodies, or signatures. Callers (the /sign route) own logging with sub-org
 * id only.
 */
import { serializeSignature } from "@turnkey/ethers";
import { Challenge, Credential } from "mppx";
import { TxEnvelopeTempo } from "ox/tempo";
import { encodeFunctionData, keccak256 } from "viem";
import { Abis } from "viem/tempo";
import { BASE_RAIL } from "@/lib/payments/rails";
import {
  runTurnkeyActivity,
  type TurnkeyActivityErrorSpec,
  type TurnkeySignature,
  type TurnkeySignRawPayloadActivityResult,
} from "@/lib/turnkey/activity";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import { BASE_CHAIN_ID, USDC_BASE_ADDRESS } from "./constants";

const MPP_AUTH_PREFIX = "Payment ";

// Sponsor policy (mirror of mppx/src/tempo/internal/fee-payer.ts::policy):
//   maxGas 2,000,000; maxFeePerGas 100 gwei; maxPriorityFeePerGas 10 gwei;
//   maxValidityWindowSeconds 15 * 60.
// We pick conservative values well under the ceilings -- transferWithMemo
// costs ~100k gas, so 500k is generous headroom for price-spike retries.
// maxFeePerGas is the user's CEILING, not the actual fee paid -- the fee-payer
// settles only the network base fee, not the cap, so high values are safe.
// Tempo's observed base fee runs ~20 gwei; 50 gwei gives ~2.5x headroom while
// staying well under the sponsor's 100 gwei policy. Setting maxFeePerGas
// below the live base fee gets the broadcast rejected by the Tempo node, and
// the resulting plain Error falls through mppx's catch-all as a reason-less
// VerificationFailedError.
const MPP_TX_GAS = BigInt(500_000);
const MPP_TX_MAX_FEE_PER_GAS = BigInt(50_000_000_000); // 50 gwei
// TIP-1009 expiring-nonce hard limit: validBefore must fall within 30s of the
// chain's block timestamp at broadcast time. Tempo's nonce manager rejects
// `eth_sendRawTransactionSync` outright if the envelope sets a longer window
// (`nonce manager error: expiring nonce valid_before too far in the future`).
// Match mppx/client/Charge.js's 25s budget so the round-trip
// (sign -> /sign returns -> client retry -> server broadcasts) stays well
// inside the 30s ceiling even with a multi-second Turnkey latency.
const MPP_TX_VALIDITY_WINDOW_SECONDS = 25;

// TIP-1009 expiring-nonce marker. viem/tempo/chainConfig.js rewrites
// `{nonceKey: 'expiring'}` to `{nonceKey: 2**256-1, nonce: 0}`; we hardcode
// the same values because we build the envelope by hand (no viem
// prepareTransactionRequest on the Turnkey path).
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

// MPP attribution memo layout (mirrors mppx/tempo/Attribution.encode):
//   bytes 0..3   : tag         keccak256("mpp")[0..3] = 0xef1ed712
//   byte  4      : version     1
//   bytes 5..14  : serverId    first 10 bytes of keccak256(serverId)
//   bytes 15..24 : clientId    first 10 bytes of keccak256(clientId) (zero if unset)
//   bytes 25..31 : nonce       first 7 bytes of keccak256(challengeId)
// The mppx Attribution module isn't in the public package exports so we
// re-implement the exact layout here rather than reaching into the internal
// path. The tag bytes are NOT the literal ASCII "MPP\0" -- mppx derives them
// as `Hex.slice(keccak256("mpp"), 0, 4)` (mppx/tempo/Attribution.js:31). The
// original /sign hardcoded `[0x4d,0x50,0x50,0x00]` ("MPP\0") which made the
// memo's tag mismatch the server's expected fingerprint -- the post-broadcast
// assertChallengeBoundMemo check threw a non-PaymentError that mppx's outer
// catch wrapped as a reason-less VerificationFailedError 402.
const MPP_ATTRIBUTION_TAG = new Uint8Array([0xef, 0x1e, 0xd7, 0x12]);
const MPP_ATTRIBUTION_VERSION = 1;

function attributionFingerprint(id: string): Uint8Array {
  const hash = keccak256(new TextEncoder().encode(id));
  const bytes = new Uint8Array(10);
  for (let i = 0; i < 10; i++) {
    bytes[i] = Number.parseInt(hash.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bytes;
}

function attributionChallengeNonce(challengeId: string): Uint8Array {
  const hash = keccak256(new TextEncoder().encode(challengeId));
  const bytes = new Uint8Array(7);
  for (let i = 0; i < 7; i++) {
    bytes[i] = Number.parseInt(hash.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bytes;
}

function encodeAttributionMemo(
  challengeId: string,
  serverId: string
): `0x${string}` {
  const buf = new Uint8Array(32);
  buf.set(MPP_ATTRIBUTION_TAG, 0);
  buf[4] = MPP_ATTRIBUTION_VERSION;
  buf.set(attributionFingerprint(serverId), 5);
  // clientId (bytes 15..24) is left as zero; mppx treats absence as "no client id"
  buf.set(attributionChallengeNonce(challengeId), 25);
  const hex = Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

export class PolicyBlockedError extends Error {
  override readonly name = "PolicyBlockedError";
}

export class TurnkeyUpstreamError extends Error {
  readonly name = "TurnkeyUpstreamError";
}

const SIGN_ACTIVITY_ERRORS: TurnkeyActivityErrorSpec = {
  policyBlockedError: PolicyBlockedError,
  upstreamError: TurnkeyUpstreamError,
  policyBlockedMessage:
    "Turnkey policy blocked the activity (CONSENSUS_NEEDED)",
  missingResultMessage: "Signature missing from Turnkey response",
};

// The canonical TransferWithAuthorization EIP-712 domain for the x402 rail's
// settlement asset, taken whole from the rail. The advertised `extra` in
// payment-gate.ts and router.ts reads the same `domain`, so the pair that
// drifted in KEEP-364 is now one value rather than two that agree by review.
export const BASE_USDC_DOMAIN = {
  ...BASE_RAIL.domain,
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_BASE_ADDRESS,
} as const;

export const AUTHORIZATION_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Source: mppx proof-mode EIP-712 types (33-RESEARCH Pattern 4). chainId
// 4217 is the Tempo mainnet id.
export const PROOF_DOMAIN_TEMPO = {
  name: "MPP",
  version: "1",
  chainId: 4217,
} as const;

export const PROOF_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
  Proof: [{ name: "challengeId", type: "string" }],
} as const;

export type X402Challenge = {
  payTo: string;
  amount: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
};

export type MppProofChallenge = {
  chainId: number;
  /**
   * The raw WWW-Authenticate value (without the `Payment ` prefix) as forwarded
   * by the npm client. signMppProof parses this via `Challenge.deserialize`
   * (from mppx) to derive the challenge id it signs, and then wraps the raw
   * EIP-712 signature into a spec-compliant Credential envelope so the caller
   * can pass the returned string straight into `Authorization: Payment <...>`
   * without any client-side decoding or mutation.
   */
  serialized: string;
};

/**
 * Calls Turnkey `signRawPayload` with a precomputed hex hash. Returned
 * signature is a raw ECDSA triple `{r, s, v}` where v is the yParity bit as
 * a two-char hex string ("00" or "01"). Callers are responsible for
 * assembling this into whatever wire format the downstream verifier expects
 * (Ethereum v+27 for secp256k1 signatures, Tempo SignatureEnvelope's raw
 * yParity, Solana raw concat, etc). See the two callers below for examples.
 */
function signRawHash(
  subOrgId: string,
  walletAddress: string,
  hexHash: string
): Promise<TurnkeySignature> {
  const client = getTurnkeyClientForOrg(subOrgId).apiClient();
  return runTurnkeyActivity<
    TurnkeySignRawPayloadActivityResult,
    TurnkeySignature
  >(
    client,
    "signRawPayload",
    {
      signWith: walletAddress,
      payload: hexHash,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
    (result) => result?.signRawPayloadResult,
    SIGN_ACTIVITY_ERRORS
  );
}

async function signTypedData(
  subOrgId: string,
  walletAddress: string,
  typedData: unknown
): Promise<string> {
  const client = getTurnkeyClientForOrg(subOrgId).apiClient();
  // Turnkey SDK v5.3.0's `signRawPayload` expects parameters FLAT (not nested
  // under a `parameters` object as the raw v1 activity API required). The
  // original v1 envelope `{type, organizationId, timestampMs, parameters}`
  // was rejected with "field required: signWith / payload / encoding".
  const result = await runTurnkeyActivity<
    TurnkeySignRawPayloadActivityResult,
    TurnkeySignature
  >(
    client,
    "signRawPayload",
    {
      signWith: walletAddress,
      payload: JSON.stringify(typedData),
      encoding: "PAYLOAD_ENCODING_EIP712",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
    (activityResult) => activityResult?.signRawPayloadResult,
    SIGN_ACTIVITY_ERRORS
  );

  // serializeSignature assembles `0x${r}${s}${hex(v+27)}` (65 bytes / 132 hex
  // chars). It handles the Turnkey `v: "00"|"01"` -> Ethereum `v: 27|28`
  // parity offset required by EIP-3009 / EIP-712 recipients.
  return serializeSignature(result);
}

export function signX402Challenge(
  subOrgId: string,
  walletAddress: string,
  challenge: X402Challenge
): Promise<string> {
  const message = {
    from: walletAddress,
    to: challenge.payTo,
    value: String(challenge.amount),
    validAfter: String(challenge.validAfter),
    validBefore: String(challenge.validBefore),
    nonce: challenge.nonce,
  };
  const typedData = {
    domain: BASE_USDC_DOMAIN,
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  };
  return signTypedData(subOrgId, walletAddress, typedData);
}

export async function signMppProof(
  subOrgId: string,
  walletAddress: string,
  challenge: MppProofChallenge
): Promise<string> {
  // Parse the raw WWW-Authenticate parameters into a structured mppx Challenge
  // so we (a) have the canonical challenge id to sign, and (b) can wrap the
  // raw signature into a spec-compliant Credential envelope below. Without
  // the wrap the facilitator rejects every retry with "Credential is
  // malformed: Invalid base64url or JSON".
  //
  // The npm client strips the `Payment ` scheme token before forwarding, but
  // Challenge.deserialize expects the full `Payment <params>` form. Re-add the
  // prefix on input so either form works.
  const input = challenge.serialized.startsWith(MPP_AUTH_PREFIX)
    ? challenge.serialized
    : `${MPP_AUTH_PREFIX}${challenge.serialized}`;
  const parsed = Challenge.deserialize(input);

  // Override PROOF_DOMAIN_TEMPO.chainId if the caller supplies a different
  // chainId (e.g. Tempo testnet). Default path is 4217 from the challenge.
  const typedData = {
    domain: { ...PROOF_DOMAIN_TEMPO, chainId: challenge.chainId },
    types: PROOF_TYPES,
    primaryType: "Proof",
    message: { challengeId: parsed.id },
  };
  const rawSignature = await signTypedData(subOrgId, walletAddress, typedData);

  // Wrap into an MPP Credential and base64url-encode per mppx spec so
  // `Credential.serialize()` produces `"Payment eyJ..."`. The npm client
  // prepends its own `Payment ` scheme token when building the Authorization
  // header, so we strip the prefix on the way out and ship only the encoded
  // payload. Opaque pass-through from the client's point of view.
  // `type` is the discriminator in mppx Methods.charge.schema.credential.payload
  // (tempo/Methods.ts). Without it the schema parse rejects the credential
  // with "Credential payload is invalid" before any crypto check runs.
  const credential = Credential.from({
    challenge: parsed,
    payload: { type: "proof", signature: rawSignature },
  });
  const serialized = Credential.serialize(credential);
  return serialized.startsWith(MPP_AUTH_PREFIX)
    ? serialized.slice(MPP_AUTH_PREFIX.length)
    : serialized;
}

/**
 * Input shape for charge-intent MPP signing. chainId mirrors
 * MppProofChallenge.chainId (Tempo mainnet 4217 or testnet 4218). The
 * serialized challenge is forwarded verbatim from the npm client (the raw
 * WWW-Authenticate parameters minus the `Payment ` scheme token).
 */
export type MppTransactionChallenge = {
  chainId: number;
  serialized: string;
};

/**
 * Parsed shape of a Tempo `charge` request after Challenge.deserialize has
 * base64-decoded the `request` field. The server side of mppx validates
 * recipient, currency, amount, and methodDetails.chainId during settlement,
 * so we thread them verbatim into the transferWithMemo call.
 */
type TempoChargeRequest = {
  amount: string;
  currency: `0x${string}`;
  recipient: `0x${string}`;
  methodDetails?: { chainId?: number } | undefined;
};

/**
 * Signs a non-zero MPP charge intent by building a Tempo `transferWithMemo`
 * transaction, signing the envelope hash via Turnkey, and returning a
 * spec-compliant Credential envelope ready for `Authorization: Payment`
 * on the retry.
 *
 * Agent side does NOT hold a fee payer -- the KeeperHub-hosted mppx
 * facilitator sponsors gas via `FeePayer.prepareSponsoredTransaction` which
 * wraps the 0x76 envelope we produce here into a 0x78 co-signed form before
 * broadcast. Our job is strictly to produce a valid agent-signed 0x76 tx.
 *
 * The memo is `Attribution.encode({challengeId, serverId: challenge.realm})`
 * which binds the Transfer log to this specific challenge -- required by
 * mppx's assertChallengeBoundMemo check when the workflow doesn't set an
 * explicit memo.
 */
export async function signMppTransaction(
  subOrgId: string,
  walletAddressTempo: string,
  params: MppTransactionChallenge
): Promise<string> {
  const input = params.serialized.startsWith(MPP_AUTH_PREFIX)
    ? params.serialized
    : `${MPP_AUTH_PREFIX}${params.serialized}`;
  const parsed = Challenge.deserialize(input);

  if (parsed.intent !== "charge") {
    throw new TurnkeyUpstreamError(
      `MPP intent "${parsed.intent}" not supported by signMppTransaction (charge only)`
    );
  }

  const request = parsed.request as unknown as TempoChargeRequest;
  if (
    !(request?.recipient && request.currency && request.amount) ||
    BigInt(request.amount) <= BigInt(0)
  ) {
    throw new TurnkeyUpstreamError(
      "MPP charge challenge missing recipient, currency, or non-zero amount"
    );
  }

  const memo = encodeAttributionMemo(parsed.id, parsed.realm);

  const callData = encodeFunctionData({
    abi: Abis.tip20,
    functionName: "transferWithMemo",
    args: [request.recipient, BigInt(request.amount), memo],
  });

  // TIP-1009 expiring nonce: nonceKey MUST be uint256.max and nonce MUST be
  // 0. Tempo's fee-payer sponsored path only co-signs transactions that use
  // this marker; any other nonceKey is treated as a 2D-nonce (non-expiring)
  // and the facilitator's FeePayer.prepareSponsoredTransaction / signTransaction
  // chain throws, which mppx's server catch-all wraps as a reason-less
  // "Payment verification failed" 402. Mirrors mppx/client/Charge.js which
  // passes `nonceKey: 'expiring'` to prepareTransactionRequest (rewritten by
  // viem/tempo chainConfig into this same MAX_UINT256 + nonce 0 pair).
  const nonceKey = MAX_UINT256;
  const nonce = BigInt(0);

  const nowSec = Math.floor(Date.now() / 1000);
  const validBefore = nowSec + MPP_TX_VALIDITY_WINDOW_SECONDS;

  const envelope = TxEnvelopeTempo.from({
    chainId: params.chainId,
    calls: [
      {
        to: request.currency,
        data: callData,
      },
    ],
    nonce,
    nonceKey,
    gas: MPP_TX_GAS,
    maxFeePerGas: MPP_TX_MAX_FEE_PER_GAS,
    validBefore,
  });

  const sighash = TxEnvelopeTempo.getSignPayload(envelope);

  const tkSig = await signRawHash(subOrgId, walletAddressTempo, sighash);

  // Tempo's SignatureEnvelope.Secp256k1 takes the RAW yParity bit (0 | 1),
  // not Ethereum's v+27 convention. Bumping v by 27 here would produce an
  // envelope the facilitator recovers to a different address, so do NOT
  // reuse @turnkey/ethers::serializeSignature on this path.
  const yParity = Number.parseInt(tkSig.v, 16);
  if (yParity !== 0 && yParity !== 1) {
    throw new TurnkeyUpstreamError(
      `Turnkey returned unexpected v-parity "${tkSig.v}" (expected 00 or 01)`
    );
  }
  const signatureEnvelope = {
    type: "secp256k1" as const,
    signature: {
      r: BigInt(`0x${tkSig.r}`),
      s: BigInt(`0x${tkSig.s}`),
      yParity: yParity as 0 | 1,
    },
  };

  const signed = TxEnvelopeTempo.from(envelope, {
    signature: signatureEnvelope,
  });
  const serializedTx = TxEnvelopeTempo.serialize(signed);

  // Credential.from sets source on the credential object; facilitator's
  // proof path requires it, transaction path uses it for attribution.
  // `type: "transaction"` is the schema discriminator in
  // mppx/tempo/Methods.ts::charge (payload is a z.discriminatedUnion on
  // 'type'). Without it the credential fails schema parse before any crypto
  // validation runs -> "Credential payload is invalid".
  const credential = Credential.from({
    challenge: parsed,
    payload: { type: "transaction", signature: serializedTx },
    source: `did:pkh:eip155:${params.chainId}:${walletAddressTempo}`,
  });
  const out = Credential.serialize(credential);
  return out.startsWith(MPP_AUTH_PREFIX)
    ? out.slice(MPP_AUTH_PREFIX.length)
    : out;
}
