import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type {
  SignTypedDataCoreInput,
  SignTypedDataResult,
} from "./sign-typed-data-core";
import { signTypedDataCore } from "./sign-typed-data-core";

export type { SignTypedDataResult } from "./sign-typed-data-core";

export type SignTypedDataInput = StepInput & SignTypedDataCoreInput;

/**
 * Sign Typed Data (EIP-712) Step
 * Produces a 65-byte secp256k1 signature over an EIP-712 typed-data object
 * using the organization's Turnkey-backed wallet, for arbitrary protocol
 * intents that need an off-chain signature destined for an HTTP body or
 * contract argument. Fund-moving authorizations (permits, transfer
 * authorizations, delegations) are refused on this step - see
 * sign-typed-data-core.
 */
export async function signTypedDataStep(
  input: SignTypedDataInput
): Promise<SignTypedDataResult> {
  "use step";

  return runPluginStep(
    { pluginName: "web3", actionName: "sign-typed-data" },
    input,
    signTypedDataCore
  );
}

// Security-critical: do not auto-retry a signing call. A retried sign
// produces a fresh signature (different IV-equivalent randomness inside
// Turnkey) which the caller's downstream HTTP retry may double-spend.
signTypedDataStep.maxRetries = 0;

export const _integrationType = "web3";
