import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  absBigInt,
  align,
  divideScaled,
  formatScaled,
  parseDecimal,
  pow10,
  rescale,
} from "./decimal-core";

const PLUGIN_NAME = "math";
const ACTION_NAME = "compare-tolerance";

const DEFAULT_PRECISION = 6;
const MAX_PRECISION = 30;
const HUNDRED = BigInt(100);
const ZERO = BigInt(0);

const MODES = ["percent", "absolute"] as const;
type Mode = (typeof MODES)[number];

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

function failed(error: string): CompareToleranceResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function resolveMode(raw: string | undefined): Mode {
  return raw === "absolute" ? "absolute" : "percent";
}

function resolvePrecision(raw: string | number | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PRECISION;
  }
  return Math.min(Math.trunc(parsed), MAX_PRECISION);
}

function directionOf(difference: bigint): "above" | "below" | "equal" {
  if (difference > ZERO) {
    return "above";
  }
  if (difference < ZERO) {
    return "below";
  }
  return "equal";
}

/**
 * Percent tolerance without dividing first: `|diff| / |expected| <= tol / 100`
 * is checked as `|diff| * 100 * 10^td <= tol * |expected|`, so both sides stay
 * integral and nothing is lost at RAD/WAD magnitudes.
 */
function isWithinPercent(
  absoluteDifference: bigint,
  expected: bigint,
  tolerance: { value: bigint; decimals: number }
): boolean {
  if (expected === ZERO) {
    return absoluteDifference === ZERO;
  }
  const left = absoluteDifference * HUNDRED * pow10(tolerance.decimals);
  const right = absBigInt(tolerance.value) * absBigInt(expected);
  return left <= right;
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

    const aligned = align(actual, expected);
    const difference = aligned.a - aligned.b;
    const absoluteDifference = absBigInt(difference);

    const withinTolerance =
      mode === "absolute"
        ? absoluteDifference <= absBigInt(rescale(tolerance, aligned.decimals))
        : isWithinPercent(absoluteDifference, aligned.b, tolerance);

    return {
      success: true,
      withinTolerance,
      breached: !withinTolerance,
      direction: directionOf(difference),
      difference: formatScaled(difference, aligned.decimals),
      absoluteDifference: formatScaled(absoluteDifference, aligned.decimals),
      percentDifference: percentDifferenceOf(difference, aligned.b, precision),
      actual: formatScaled(aligned.a, aligned.decimals),
      expected: formatScaled(aligned.b, aligned.decimals),
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
