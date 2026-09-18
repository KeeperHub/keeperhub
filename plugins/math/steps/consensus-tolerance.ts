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
const ACTION_NAME = "consensus-tolerance";

const DEFAULT_PRECISION = 6;
const MAX_PRECISION = 30;
const HUNDRED = BigInt(100);
const ZERO = BigInt(0);

const MODES = ["percent", "absolute"] as const;
type Mode = (typeof MODES)[number];

export type ConsensusToleranceCoreInput = {
  values: string; // Comma, newline or JSON array of strings/numbers
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
      minSourcesMet: boolean;
      maxDeviation: string;
      maxPercentDeviation: string | null;
      mode: Mode;
      tolerance: string;
      median: string;
      values: string[];
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): ConsensusToleranceResult {
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

function parseValues(raw: string): string[] {
  if (!raw || typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (typeof item === "object" && item !== null ? String(item.value ?? item.price ?? item.result ?? item) : String(item))).filter(Boolean);
      }
    } catch {
      // Fallback to text parsing
    }
  }
  return trimmed
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPairWithinPercent(
  absDiff: bigint,
  base: bigint,
  tolerance: { value: bigint; decimals: number }
): boolean {
  if (base === ZERO) return absDiff === ZERO;
  const left = absDiff * HUNDRED * pow10(tolerance.decimals);
  const right = absBigInt(tolerance.value) * absBigInt(base);
  return left <= right;
}

function stepHandler(input: ConsensusToleranceCoreInput): ConsensusToleranceResult {
  try {
    const rawList = parseValues(input.values);
    const minRequired = typeof input.minSources === "number" ? input.minSources : Number(input.minSources) || 2;
    if (rawList.length < minRequired) {
      return failed(`Insufficient sources: got ${rawList.length}, minimum required is ${minRequired}`);
    }

    const tolerance = parseDecimal(input.tolerance, "Tolerance");
    const mode = resolveMode(input.mode);
    const precision = resolvePrecision(input.precision);

    const parsedDecimals = rawList.map((val, idx) => parseDecimal(val, `Source ${idx + 1}`));
    const maxDecimals = Math.max(...parsedDecimals.map((d) => d.decimals));
    const normalized = parsedDecimals.map((d) => rescale(d, maxDecimals));

    let maxDiff = ZERO;
    let maxDiffBase = ZERO;
    let inConsensus = true;

    // Check all pairwise combinations
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        const a = normalized[i];
        const b = normalized[j];
        const diff = absBigInt(a - b);
        const base = absBigInt(b);

        if (diff > maxDiff) {
          maxDiff = diff;
          maxDiffBase = base;
        }

        const pairOk =
          mode === "absolute"
            ? diff <= absBigInt(rescale(tolerance, maxDecimals))
            : isPairWithinPercent(diff, base, tolerance);

        if (!pairOk) {
          inConsensus = false;
        }
      }
    }

    // Compute median for reporting
    const sorted = [...normalized].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const mid = Math.floor(sorted.length / 2);
    const medianVal = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / BigInt(2) : sorted[mid];

    const maxPercent = maxDiffBase === ZERO ? null : formatScaled(divideScaled(maxDiff * HUNDRED, maxDiffBase, precision), precision);

    return {
      success: true,
      inConsensus,
      sourceCount: rawList.length,
      minSourcesMet: true,
      maxDeviation: formatScaled(maxDiff, maxDecimals),
      maxPercentDeviation: maxPercent,
      mode,
      tolerance: formatScaled(tolerance.value, tolerance.decimals),
      median: formatScaled(medianVal, maxDecimals),
      values: rawList,
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
