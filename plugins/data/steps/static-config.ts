import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { isPlainObject, parseJsonValue } from "./resolve-path-core";

const PLUGIN_NAME = "data";
const ACTION_NAME = "static-config";

export type StaticConfigCoreInput = {
  value: string;
};

export type StaticConfigInput = StepInput & StaticConfigCoreInput;

type StaticConfigResult =
  | {
      success: true;
      result: unknown;
      keys: string[];
      count: number;
      valueType: "object" | "array" | "primitive";
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): StaticConfigResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function describe(value: unknown): StaticConfigResult {
  if (Array.isArray(value)) {
    return {
      success: true,
      result: value,
      keys: [],
      count: value.length,
      valueType: "array",
    };
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return {
      success: true,
      result: value,
      keys,
      count: keys.length,
      valueType: "object",
    };
  }
  return {
    success: true,
    result: value,
    keys: [],
    count: 1,
    valueType: "primitive",
  };
}

function stepHandler(input: StaticConfigCoreInput): StaticConfigResult {
  try {
    return describe(parseJsonValue(input.value, "Value"));
  } catch (error) {
    return failed(`Static config failed: ${getErrorMessage(error)}`);
  }
}

export async function staticConfigStep(
  input: StaticConfigInput
): Promise<StaticConfigResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

staticConfigStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
