import "server-only";

import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  absBigInt,
  type Decimal,
  divideCeil,
  failed,
  formatScaled,
  HUNDRED,
  isWithinAbsolute,
  isWithinPercent,
  medianScaled,
  type Mode,
  parseDecimal,
  parseValueList,
  pow10,
  rescale,
  resolveMode,
  resolvePrecision,
  ZERO,
} from "./decimal-core";

const PLUGIN_NAME = "math";
const ACTION_NAME = "consensus-tolerance";

/** A consensus check over one source is meaningless, so two is the floor. */
const MIN_SOURCES_FLOOR = 2;
const ONE = BigInt(1);
const LINE_SEPARATOR = /\r?\n/;

export type ConsensusToleranceCoreInput = {
  values: string; // Newline-separated list or JSON array of strings/numbers
  tolerance: string;
  mode?: string;
  precision?: string | number;
  minSources?: string | number;
};

export type ConsensusToleranceInput = StepInput & ConsensusToleranceCoreInput;

type ConsensusToleranceResult =
  | {
      success: true;
      inConsensus: boolean;
      sourceCount: number;
      maxDeviation: string;
      maxPercentDeviation: string;
      mode: Mode;
      tolerance: string;
      median: string;
      values: string[];
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

type PairwiseScan = {
  maxDifference: bigint;
  worstPercentDifference: bigint;
  worstPercentBase: bigint;
  inConsensus: boolean;
};

function resolveMinSources(raw: string | number | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    return MIN_SOURCES_FLOOR;
  }
  return Math.max(MIN_SOURCES_FLOOR, Math.trunc(parsed));
}

/** Symmetric percent base, so the verdict does not depend on source order. */
function maxAbs(a: bigint, b: bigint): bigint {
  const absA = absBigInt(a);
  const absB = absBigInt(b);
  return absA > absB ? absA : absB;
}

function scanPairs(
  normalized: bigint[],
  decimals: number,
  tolerance: Decimal,
  mode: Mode
): PairwiseScan {
  let maxDifference = ZERO;
  let worstPercentDifference = ZERO;
  let worstPercentBase = ONE;
  let inConsensus = true;

  for (const [index, a] of normalized.entries()) {
    for (const b of normalized.slice(index + 1)) {
      const difference = absBigInt(a - b);
      const base = maxAbs(a, b);

      if (difference > maxDifference) {
        maxDifference = difference;
      }

      // Cross-multiplied so the worst ratio is tracked, not the worst numerator.
      if (difference * worstPercentBase > worstPercentDifference * base) {
        worstPercentDifference = difference;
        worstPercentBase = base;
      }

      const pairWithin =
        mode === "absolute"
          ? isWithinAbsolute(difference, decimals, tolerance)
          : isWithinPercent(difference, base, tolerance);

      if (!pairWithin) {
        inConsensus = false;
      }
    }
  }

  return {
    maxDifference,
    worstPercentDifference,
    worstPercentBase,
    inConsensus,
  };
}

/** Rounded up so only a genuinely zero spread can render as "0". */
function percentDeviationOf(scan: PairwiseScan, precision: number): string {
  if (scan.worstPercentDifference === ZERO) {
    return "0";
  }
  return formatScaled(
    divideCeil(
      scan.worstPercentDifference * HUNDRED * pow10(precision),
      scan.worstPercentBase
    ),
    precision
  );
}

function stepHandler(
  input: ConsensusToleranceCoreInput
): ConsensusToleranceResult {
  try {
    const sources = parseValueList(input.values, LINE_SEPARATOR);
    const minRequired = resolveMinSources(input.minSources);
    if (sources.length < minRequired) {
      return failed(
        `Insufficient sources: got ${sources.length}, minimum required is ${minRequired}`
      );
    }

    const tolerance = parseDecimal(input.tolerance, "Tolerance");
    const mode = resolveMode(input.mode);
    const precision = resolvePrecision(input.precision);

    const parsed = sources.map((value, index) =>
      parseDecimal(value, `Source ${index + 1}`)
    );
    const decimals = Math.max(...parsed.map((entry) => entry.decimals));
    const normalized = parsed.map((entry) => rescale(entry, decimals));

    const scan = scanPairs(normalized, decimals, tolerance, mode);
    const median = medianScaled(normalized, decimals);

    return {
      success: true,
      inConsensus: scan.inConsensus,
      sourceCount: sources.length,
      maxDeviation: formatScaled(scan.maxDifference, decimals),
      maxPercentDeviation: percentDeviationOf(scan, precision),
      mode,
      tolerance: formatScaled(tolerance.value, tolerance.decimals),
      median: formatScaled(median.value, median.decimals),
      values: sources,
    };
  } catch (error) {
    return failed(`Consensus tolerance failed: ${getErrorMessage(error)}`);
  }
}

export async function consensusToleranceStep(
  input: ConsensusToleranceInput
): Promise<ConsensusToleranceResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

consensusToleranceStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
