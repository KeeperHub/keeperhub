import "server-only";

import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  absBigInt,
  alignAll,
  divideScaled,
  failed,
  formatScaled,
  HUNDRED,
  isWithinAbsolute,
  isWithinPercent,
  type Mode,
  parseDecimal,
  resolveMode,
  resolvePrecision,
  ZERO,
} from "./decimal-core";

const PLUGIN_NAME = "math";
const ACTION_NAME = "compare-tolerance";

export type CompareToleranceCoreInput = {
  actual: string;
  expected: string;
  tolerance: string;
  mode?: string;
  precision?: string | number;
};

export type CompareToleranceInput = StepInput & CompareToleranceCoreInput;

type CompareToleranceResult =
  | {
      success: true;
      withinTolerance: boolean;
      breached: boolean;
      direction: "above" | "below" | "equal";
      difference: string;
      absoluteDifference: string;
      percentDifference: string | null;
      actual: string;
      expected: string;
      tolerance: string;
      mode: Mode;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function directionOf(difference: bigint): "above" | "below" | "equal" {
  if (difference > ZERO) {
    return "above";
  }
  if (difference < ZERO) {
    return "below";
  }
  return "equal";
}

function percentDifferenceOf(
  difference: bigint,
  expected: bigint,
  precision: number
): string | null {
  if (expected === ZERO) {
    return null;
  }
  const scaled = divideScaled(
    difference * HUNDRED,
    absBigInt(expected),
    precision
  );
  return formatScaled(scaled, precision);
}

function stepHandler(input: CompareToleranceCoreInput): CompareToleranceResult {
  try {
    const actual = parseDecimal(input.actual, "Actual");
    const expected = parseDecimal(input.expected, "Expected");
    const tolerance = parseDecimal(input.tolerance, "Tolerance");
    const mode = resolveMode(input.mode);
    const precision = resolvePrecision(input.precision);

    const { values, scale } = alignAll([actual, expected]);
    const [actualScaled, expectedScaled] = values;
    const difference = actualScaled - expectedScaled;
    const absoluteDifference = absBigInt(difference);

    const withinTolerance =
      mode === "absolute"
        ? isWithinAbsolute(absoluteDifference, scale, tolerance)
        : isWithinPercent(absoluteDifference, expectedScaled, tolerance);

    return {
      success: true,
      withinTolerance,
      breached: !withinTolerance,
      direction: directionOf(difference),
      difference: formatScaled(difference, scale),
      absoluteDifference: formatScaled(absoluteDifference, scale),
      percentDifference: percentDifferenceOf(
        difference,
        expectedScaled,
        precision
      ),
      actual: formatScaled(actualScaled, scale),
      expected: formatScaled(expectedScaled, scale),
      tolerance: formatScaled(tolerance.value, tolerance.decimals),
      mode,
    };
  } catch (error) {
    return failed(`Compare failed: ${getErrorMessage(error)}`);
  }
}

export async function compareToleranceStep(
  input: CompareToleranceInput
): Promise<CompareToleranceResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

compareToleranceStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
