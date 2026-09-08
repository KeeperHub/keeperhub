/**
 * Generic EIP-712 typed-data signing primitive.
 *
 * KEEP-473: x402 / EIP-3009 / arbitrary buyer-side flows need to sign
 * typed-data payloads from inside a workflow. The original sign.ts file
 * exposes purpose-built helpers (signX402Challenge, signMppProof) that
 * hardcode the domain and types. Workflow steps and MCP tools need the
 * underlying primitive that takes a caller-supplied typed-data object.
 *
 * Shared with `lib/agentic-wallet/sign.ts`; that module's `signTypedData`
 * function delegates here so the Turnkey call shape stays in one place.
 *
 * IMPORTANT: this primitive does NOT consult any allowlist of EIP-712
 * domains. Callers (the workflow step, the MCP tool, the agentic-wallet
 * sign route) are responsible for policy: e.g. the step caps payload size,
 * the sign route applies HMAC + Turnkey-policy gates. Adding domain
 * filtering here would silently break the x402/MPP signers that legitimately
 * sign arbitrary buyer-side payloads.
 */
import { serializeSignature } from "@turnkey/ethers";
import {
  runTurnkeyActivity,
  type TurnkeyActivityErrorSpec,
  type TurnkeySignature,
  type TurnkeySignRawPayloadActivityResult,
} from "@/lib/turnkey/activity";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import { toJsonSafe } from "@/lib/utils/json-safe";

export class PolicyBlockedError extends Error {
  override readonly name = "PolicyBlockedError";
}

export class TurnkeyUpstreamError extends Error {
  override readonly name = "TurnkeyUpstreamError";
}

const SIGN_ACTIVITY_ERRORS: TurnkeyActivityErrorSpec = {
  policyBlockedError: PolicyBlockedError,
  upstreamError: TurnkeyUpstreamError,
  policyBlockedMessage:
    "Turnkey policy blocked the activity (CONSENSUS_NEEDED)",
  missingResultMessage: "Signature missing from Turnkey response",
};

export type EIP712TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

/**
 * Sign an EIP-712 typed-data object via Turnkey and return the 65-byte
 * `0x`-prefixed signature with `v` parity offset to Ethereum's (v+27)
 * convention via `@turnkey/ethers::serializeSignature` (suitable for
 * EIP-3009 / EIP-712 recipients that expect 27|28, not 0|1).
 *
 * Throws PolicyBlockedError on ACTIVITY_STATUS_CONSENSUS_NEEDED so callers
 * can translate to a 403 policy-block. Any other non-COMPLETED status
 * throws TurnkeyUpstreamError.
 */
export async function signTypedDataWithTurnkey(
  subOrgId: string,
  walletAddress: string,
  typedData: EIP712TypedData
): Promise<string> {
  const client = getTurnkeyClientForOrg(subOrgId).apiClient();
  // EIP-712 messages carry bigint uint256/deadline fields that JSON.stringify
  // cannot serialize; normalize them to numeric strings first.
  const payload = JSON.stringify(toJsonSafe(typedData));
  // Turnkey SDK v5.3.0's `signRawPayload` expects parameters flat (not
  // nested under `parameters`). With PAYLOAD_ENCODING_EIP712 Turnkey hashes
  // the typed-data server-side, but `hashFunction` is still required and
  // MUST be NO_OP — anything else double-hashes.
  const result = await runTurnkeyActivity<
    TurnkeySignRawPayloadActivityResult,
    TurnkeySignature
  >(
    client,
    "signRawPayload",
    {
      signWith: walletAddress,
      payload,
      encoding: "PAYLOAD_ENCODING_EIP712",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
    (activityResult) => activityResult?.signRawPayloadResult,
    SIGN_ACTIVITY_ERRORS
  );
  return serializeSignature(result);
}
