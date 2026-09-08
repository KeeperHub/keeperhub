import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  isPlainObject,
  parseJsonValue,
  resolvePath,
} from "./resolve-path-core";

const PLUGIN_NAME = "data";
const ACTION_NAME = "flatten-findings";

const DEFAULT_MAX_FINDINGS = 100;
const DEFAULT_SEVERITY = "warning";
const DEFAULT_HASH_FIELD = "transactionHash";

/** Keys an upstream monitoring node commonly carries its hits under. */
const ITEM_KEYS = [
  "events",
  "transactions",
  "logs",
  "rows",
  "items",
  "results",
] as const;

type Source = {
  label: string;
  value: unknown;
  severity?: string;
  itemsPath?: string;
};

type Finding = {
  label: string;
  severity: string;
  hash: string | null;
  item: unknown;
};

export type FlattenFindingsCoreInput = {
  sources: string;
  defaultSeverity?: string;
  hashField?: string;
  maxFindings?: string | number;
};

export type FlattenFindingsInput = StepInput & FlattenFindingsCoreInput;

type FlattenFindingsResult =
  | {
      success: true;
      anyFound: boolean;
      count: number;
      findings: Finding[];
      labels: string[];
      firstHash: string | null;
      summary: string;
      truncated: boolean;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): FlattenFindingsResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function resolveMaxFindings(raw: string | number | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_FINDINGS;
  }
  return Math.trunc(parsed);
}

function parseSources(raw: string): Source[] {
  const parsed = parseJsonValue(raw, "Sources");
  if (!Array.isArray(parsed)) {
    throw new Error(
      'Sources must be a JSON array of {"label": "...", "value": ...} entries.'
    );
  }
  return parsed.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`Source #${index + 1} must be an object.`);
    }
    return {
      label: String(entry.label ?? `Source ${index + 1}`),
      value: entry.value,
      severity:
        typeof entry.severity === "string" ? entry.severity : undefined,
      itemsPath:
        typeof entry.itemsPath === "string" ? entry.itemsPath : undefined,
    };
  });
}

/** Reduce one source value to the list of raw items it contributes. */
function itemsFromObject(value: Record<string, unknown>): unknown[] {
  for (const key of ITEM_KEYS) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  if (value.success === false) {
    return [value];
  }
  return [value];
}

function itemsFromValue(source: Source): unknown[] {
  const value =
    source.itemsPath === undefined
      ? source.value
      : resolvePath(source.value, source.itemsPath);

  if (value === null || value === undefined || value === false) {
    return [];
  }
  if (value === true) {
    return [{ triggered: true }];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "number") {
    return value === 0 ? [] : [{ value }];
  }
  if (typeof value === "string") {
    return value.trim() === "" ? [] : [{ value }];
  }
  if (isPlainObject(value)) {
    return itemsFromObject(value);
  }
  return [value];
}

function hashOf(item: unknown, hashField: string): string | null {
  const raw = resolvePath(item, hashField);
  return typeof raw === "string" ? raw : null;
}

function buildSummary(
  findings: Finding[],
  total: number,
  truncated: boolean
): string {
  if (total === 0) {
    return "No findings.";
  }
  const perLabel = new Map<string, number>();
  for (const finding of findings) {
    perLabel.set(finding.label, (perLabel.get(finding.label) ?? 0) + 1);
  }
  const lines = [`${total} finding(s):`];
  for (const [label, count] of perLabel) {
    lines.push(`- ${label}: ${count}`);
  }
  if (truncated) {
    lines.push(`- (only the first ${findings.length} are listed)`);
  }
  return lines.join("\n");
}

function stepHandler(
  input: FlattenFindingsCoreInput
): FlattenFindingsResult {
  try {
    const sources = parseSources(input.sources ?? "");
    const defaultSeverity = input.defaultSeverity?.trim() || DEFAULT_SEVERITY;
    const hashField = input.hashField?.trim() || DEFAULT_HASH_FIELD;
    const maxFindings = resolveMaxFindings(input.maxFindings);

    const findings: Finding[] = [];
    let total = 0;
    for (const source of sources) {
      for (const item of itemsFromValue(source)) {
        total++;
        if (findings.length >= maxFindings) {
          continue;
        }
        findings.push({
          label: source.label,
          severity: source.severity ?? defaultSeverity,
          hash: hashOf(item, hashField),
          item,
        });
      }
    }

    const truncated = total > findings.length;
    return {
      success: true,
      anyFound: total > 0,
      count: total,
      findings,
      labels: [...new Set(findings.map((finding) => finding.label))],
      firstHash: findings.find((finding) => finding.hash !== null)?.hash ?? null,
      summary: buildSummary(findings, total, truncated),
      truncated,
    };
  } catch (error) {
    return failed(`Flatten findings failed: ${getErrorMessage(error)}`);
  }
}

export async function flattenFindingsStep(
  input: FlattenFindingsInput
): Promise<FlattenFindingsResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

flattenFindingsStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
