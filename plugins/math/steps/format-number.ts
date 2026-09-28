import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  absBigInt,
  divideScaled,
  formatScaled,
  parseDecimal,
  pow10,
} from "./decimal-core";

const PLUGIN_NAME = "math";
const ACTION_NAME = "format-number";

const DEFAULT_PRECISION = 2;
const MAX_PRECISION = 18;
const MAX_DECIMALS = 77;
const THOUSANDS_GROUP = /\B(?=(\d{3})+(?!\d))/g;

/** Descending so the first match is the largest applicable magnitude. */
const MAGNITUDES = [
  { suffix: "T", exponent: 12 },
  { suffix: "B", exponent: 9 },
  { suffix: "M", exponent: 6 },
  { suffix: "K", exponent: 3 },
] as const;

const NOTATIONS = ["compact", "plain"] as const;
type Notation = (typeof NOTATIONS)[number];

export type FormatNumberCoreInput = {
  value: string;
  decimals?: string | number;
  precision?: string | number;
  notation?: string;
  unit?: string;
};

export type FormatNumberInput = StepInput & FormatNumberCoreInput;

type FormatNumberResult =
  | {
      success: true;
      formatted: string;
      value: string;
      magnitude: string;
      notation: Notation;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): FormatNumberResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function resolveNotation(raw: string | undefined): Notation {
  return raw === "plain" ? "plain" : "compact";
}

function clampInteger(
  raw: string | number | undefined,
  fallback: number,
  max: number
): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), max);
}

function groupThousands(text: string): string {
  const [whole, fraction] = text.split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(THOUSANDS_GROUP, ",");
  const signed = negative ? `-${grouped}` : grouped;
  return fraction === undefined ? signed : `${signed}.${fraction}`;
}

function pickMagnitude(
  scaled: bigint,
  decimals: number
): { suffix: string; exponent: number } {
  for (const magnitude of MAGNITUDES) {
    if (absBigInt(scaled) >= pow10(decimals + magnitude.exponent)) {
      return magnitude;
    }
  }
  return { suffix: "", exponent: 0 };
}

function withUnit(text: string, unit: string | undefined): string {
  const trimmed = unit?.trim();
  return trimmed ? `${text} ${trimmed}` : text;
}

function stepHandler(input: FormatNumberCoreInput): FormatNumberResult {
  try {
    const parsed = parseDecimal(input.value, "Value");
    const decimals = clampInteger(input.decimals, 0, MAX_DECIMALS);
    const precision = clampInteger(input.precision, DEFAULT_PRECISION, MAX_PRECISION);
    const notation = resolveNotation(input.notation);

    // The human value is the parsed mantissa over 10^(its own decimals + the
    // token decimals), so wei-scale integers scale down without touching floats.
    const totalDecimals = decimals + parsed.decimals;
    const scaled = parsed.value;
    const value = formatScaled(scaled, totalDecimals);

    if (notation === "plain") {
      const rounded = formatScaled(
        divideScaled(scaled, pow10(totalDecimals), precision),
        precision,
        false
      );
      return {
        success: true,
        formatted: withUnit(groupThousands(rounded), input.unit),
        value,
        magnitude: "",
        notation,
      };
    }

    const magnitude = pickMagnitude(scaled, totalDecimals);
    const divisor = pow10(totalDecimals + magnitude.exponent);
    const rounded = formatScaled(
      divideScaled(scaled, divisor, precision),
      precision,
      false
    );
    return {
      success: true,
      formatted: withUnit(`${rounded}${magnitude.suffix}`, input.unit),
      value,
      magnitude: magnitude.suffix,
      notation,
    };
  } catch (error) {
    return failed(`Format failed: ${getErrorMessage(error)}`);
  }
}

export async function formatNumberStep(
  input: FormatNumberInput
): Promise<FormatNumberResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

formatNumberStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
