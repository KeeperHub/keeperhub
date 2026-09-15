import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { PredgeCredentials } from "../credentials";
import { fetchSignedSignal, verifySignedAttestation } from "./predge-core";

type ReadSignalResult =
  | {
      success: true;
      wallet: string;
      // 0-100 conviction from Predge's on-chain track-record model.
      conviction: number;
      action: string;
      window: string;
      // The whole point: did the ed25519 signature verify offline?
      verified: boolean;
      // hex ed25519 public key that signed the signal.
      signer: string;
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
  // Verify offline against Predge's key. If PREDGE_SIGNER_KEY_ID is set on the
  // connection, only that signer is trusted; otherwise any signature that
  // matches its embedded key passes. A workflow gates execution on `verified`.
  const verified = await verifySignedAttestation(
    signed,
    credentials.PREDGE_SIGNER_KEY_ID?.trim() || undefined
  );

  const signal = signed.attestation.payload;
  return {
    success: true,
    wallet: signal.wallet ?? wallet,
    conviction: signal.conviction,
    action: signal.action,
    window: signal.window,
    verified,
    signer: signed.attestation.keyId,
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
