import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import {
  type DecodeCalldataCoreInput,
  type DecodeCalldataResult,
  decodeCalldata,
} from "./decode-calldata-core";

export type {
  DecodeCalldataCoreInput,
  DecodeCalldataResult,
  DecodedParameter,
} from "./decode-calldata-core";

export type DecodeCalldataInput = StepInput & DecodeCalldataCoreInput;

/**
 * Decode Calldata Step
 * Decodes raw transaction calldata into human-readable function calls
 * with parameter names and values using ABI databases and signature registries.
 *
 * Security-critical: maxRetries = 0 (fail-safe, not fail-open)
 */
export async function decodeCalldataStep(
  input: DecodeCalldataInput
): Promise<DecodeCalldataResult> {
  "use step";

  return runPluginStep(
    { pluginName: "web3", actionName: "decode-calldata" },
    input,
    decodeCalldata
  );
}
decodeCalldataStep.maxRetries = 0;

export const _integrationType = "web3";
