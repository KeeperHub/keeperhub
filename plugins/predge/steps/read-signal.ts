import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { PredgeCredentials } from "../credentials";
import {
  blameForBadBody,
  fetchSignedSignal,
  parseConvictionPayload,
  type PredgeAction,
  type PredgeWindow,
  verifyPredgeSignal,
} from "./predge-core";

// A successful step means a verified signal whose fields are the documented
// shape: the step fails (below) if verification does not hold OR if the signed
// payload is not a conviction signal, so success carries only checked data. A
// signature proves who issued the bytes, not what is in them, so the two are
// separate gates and both are on the error path -- not in the data as a flag an
// author could forget to gate on.
type ReadSignalResult =
  | {
      success: true;
      // The wallet the step asked for; equals the signed subject, which was
      // checked to match before this point.
      wallet: string;
      // 0-100 conviction from Predge's on-chain track-record model. Checked to
      // be a finite number in that range, never a numeric string and never
      // absent: a workflow comparing it is comparing numbers.
      conviction: number;
      // One of accumulate / reduce / hold, checked against that set.
      action: PredgeAction;
      // One of 7d / 30d, checked against that set.
      window: PredgeWindow;
      // hex ed25519 public key the signature verified against.
      signer: string;
      // ISO-8601 issue time carried by the verified attestation.
      issuedAt: string;
      // Age of the attestation in seconds at verification time. Can be slightly
      // negative within the clock-skew tolerance.
      ageSeconds: number;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export type ReadSignalCoreInput = {
  wallet: string;
};

export type ReadSignalInput = StepInput &
  ReadSignalCoreInput & {
    integrationId?: string;
  };

// Blank falls back to the default window. `0` is honored literally (reject
// anything not issued this instant) rather than silently becoming the default,
// so an operator who types it gets what they asked for. Negatives and
// non-numbers are ignored.
function parseMaxAgeSeconds(raw?: string): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// Who to blame for a verification failure, for attribution only: this changes
// no retry behaviour, it changes which side of the fence the run is filed on.
//
// Two of the reasons are only reachable because the operator configured
// something, and only then. A pinned-key mismatch is Predge rotating its signer
// unless the operator supplied their own key id, in which case a typo there
// produces exactly this. A malformed body is Predge serving garbage unless the
// operator repointed the host, in which case they are parsing something that
// was never a Predge response. Everything else is the upstream's doing.
function classifyVerificationFailure(
  reason: string | undefined,
  credentials: PredgeCredentials
): ExecutionErrorType {
  const operatorSetKeyId = Boolean(credentials.PREDGE_SIGNER_KEY_ID?.trim());
  if (reason === "signer is not the pinned Predge key" && operatorSetKeyId) {
    return ExecutionErrorType.USER;
  }
  if (reason === "malformed attestation") {
    return blameForBadBody(credentials);
  }
  return ExecutionErrorType.EXTERNAL;
}

async function stepHandler(
  input: ReadSignalCoreInput,
  credentials: PredgeCredentials
): Promise<ReadSignalResult> {
  const wallet = input.wallet?.trim();
  if (!wallet) {
    return {
      success: false,
      error: "Wallet address is required.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const result = await fetchSignedSignal(wallet, credentials);
  if (!result.success) {
    return result;
  }

  const signed = result.data;
  // Verify offline against Predge's pinned key. PREDGE_SIGNER_KEY_ID overrides
  // the pinned default; the key the response carries is never trusted on its
  // own. Binds the signal to this wallet and rejects stale attestations.
  const verification = await verifyPredgeSignal(signed, {
    requestedWallet: wallet,
    expectedKeyId: credentials.PREDGE_SIGNER_KEY_ID?.trim() || undefined,
    maxAgeSeconds: parseMaxAgeSeconds(credentials.PREDGE_MAX_SIGNAL_AGE_SECONDS),
  });

  // A gate that did not hold belongs on the error path, not in the data. Fail
  // the step with the reason rather than handing the workflow an unverified
  // payload it might act on. This also means the payload below is only read
  // once verification has vouched for it.
  if (!verification.verified) {
    return {
      success: false,
      error: `Predge signal did not verify: ${verification.reason ?? "unknown reason"}`,
      errorClass: classifyVerificationFailure(verification.reason, credentials),
    };
  }

  // The signature vouches for the bytes, not for what is in them. Everything
  // this step returns is checked against the documented shape before it can
  // reach a workflow: a conviction outside 0-100, a numeric string, a missing
  // field or an unrecognised action or window fails the step rather than being
  // handed to a gate that would coerce it.
  const parsed = parseConvictionPayload(signed.attestation.payload);
  if (!parsed.valid) {
    return {
      success: false,
      error: `Predge signal payload is not a conviction signal: ${parsed.reason}`,
      errorClass: blameForBadBody(credentials),
    };
  }

  const signal = parsed.signal;
  return {
    success: true,
    // The requested wallet; subject binding already confirmed it equals the
    // signed subject, so this never reports a different wallet than asked for.
    wallet,
    conviction: signal.conviction,
    action: signal.action,
    window: signal.window,
    signer: verification.signer,
    issuedAt: verification.issuedAt ?? "",
    ageSeconds: verification.ageSeconds ?? 0,
  };
}

export async function readSignalStep(
  input: ReadSignalInput
): Promise<ReadSignalResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "predge", actionName: "read-signal" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "predge";
