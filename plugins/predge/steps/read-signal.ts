import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { PredgeCredentials } from "../credentials";
import { fetchSignedSignal, verifyPredgeSignal } from "./predge-core";

type ReadSignalResult =
  | {
      success: true;
      wallet: string;
      // 0-100 conviction from Predge's on-chain track-record model.
      conviction: number;
      action: string;
      window: string;
      // The whole point: did the signal verify against Predge's pinned key,
      // about this wallet, recently enough? Gate execution on this.
      verified: boolean;
      // Why verification failed, when it did. Empty on a clean pass.
      reason: string;
      // hex ed25519 public key the attestation claims to be signed by.
      signer: string;
      // Whether the signed payload is about the requested wallet.
      subjectMatch: boolean;
      // ISO-8601 issue time of the attestation, when present.
      issuedAt: string;
      // Age of the attestation in seconds at verification time (-1 if unknown).
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

function parseMaxAgeSeconds(raw?: string): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
  // own. Binds the signal to this wallet and rejects stale attestations. A
  // workflow gates execution on `verified`.
  const verification = await verifyPredgeSignal(signed, {
    requestedWallet: wallet,
    expectedKeyId: credentials.PREDGE_SIGNER_KEY_ID?.trim() || undefined,
    maxAgeSeconds: parseMaxAgeSeconds(credentials.PREDGE_MAX_SIGNAL_AGE_SECONDS),
  });

  const signal = signed.attestation.payload;
  return {
    success: true,
    wallet: signal.wallet ?? wallet,
    conviction: signal.conviction,
    action: signal.action,
    window: signal.window,
    verified: verification.verified,
    reason: verification.reason ?? "",
    signer: verification.signer,
    subjectMatch: verification.subjectMatch,
    issuedAt: verification.issuedAt ?? "",
    ageSeconds: verification.ageSeconds ?? -1,
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
