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
const ACTION_NAME = "extract-fields";

const LINE_SPLIT = /\r?\n/;
const NAME_ASSIGNMENT = /^([A-Za-z_$][\w$]*)\s*=\s*(.+)$/;
const PATH_SEPARATOR = ".";

const MISSING_BEHAVIOURS = ["null", "empty", "fail"] as const;
type MissingBehaviour = (typeof MISSING_BEHAVIOURS)[number];

const MODES = ["object", "array"] as const;
type Mode = (typeof MODES)[number];

type FieldSpec = { name: string; path: string };

export type ExtractFieldsCoreInput = {
  source: string;
  paths: string;
  mode?: string;
  onMissing?: string;
};

export type ExtractFieldsInput = StepInput & ExtractFieldsCoreInput;

type ExtractFieldsResult =
  | {
      success: true;
      fields: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
      missing: string[];
      foundCount: number;
      itemCount: number;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): ExtractFieldsResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function resolveMode(raw: string | undefined): Mode {
  return raw === "array" ? "array" : "object";
}

function resolveMissingBehaviour(raw: string | undefined): MissingBehaviour {
  const candidate = (raw ?? "null") as MissingBehaviour;
  return MISSING_BEHAVIOURS.includes(candidate) ? candidate : "null";
}

function defaultNameFor(path: string): string {
  const segments = path.split(PATH_SEPARATOR);
  return segments.at(-1) ?? path;
}

function parseFieldSpecs(raw: string): FieldSpec[] {
  const specs: FieldSpec[] = [];
  for (const line of raw.split(LINE_SPLIT)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = NAME_ASSIGNMENT.exec(trimmed);
    if (assignment) {
      specs.push({ name: assignment[1], path: assignment[2].trim() });
      continue;
    }
    specs.push({ name: defaultNameFor(trimmed), path: trimmed });
  }
  if (specs.length === 0) {
    throw new Error(
      "Fields is required. Provide one path per line, e.g. vat = data.result.vat"
    );
  }
  return specs;
}

function missingValueFor(behaviour: MissingBehaviour): unknown {
  return behaviour === "empty" ? "" : null;
}

function extractOne(
  source: unknown,
  specs: FieldSpec[],
  behaviour: MissingBehaviour,
  missing: string[]
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const spec of specs) {
    const value = resolvePath(source, spec.path);
    if (value === undefined) {
      if (behaviour === "fail") {
        throw new Error(`Path "${spec.path}" was not found in the source.`);
      }
      missing.push(spec.name);
      fields[spec.name] = missingValueFor(behaviour);
      continue;
    }
    fields[spec.name] = value;
  }
  return fields;
}

function toItems(source: unknown): unknown[] {
  if (Array.isArray(source)) {
    return source;
  }
  if (isPlainObject(source)) {
    return [source];
  }
  throw new Error(
    "Array mode needs a JSON array. Reference the array field directly, e.g. {{@node1:Label.rows}}."
  );
}

function stepHandler(input: ExtractFieldsCoreInput): ExtractFieldsResult {
  try {
    const source = parseJsonValue(input.source, "Source");
    const specs = parseFieldSpecs(input.paths ?? "");
    const behaviour = resolveMissingBehaviour(input.onMissing);
    const missing: string[] = [];

    if (resolveMode(input.mode) === "array") {
      const items = toItems(source).map((item) =>
        extractOne(item, specs, behaviour, missing)
      );
      return {
        success: true,
        fields: {},
        items,
        missing: [...new Set(missing)],
        foundCount: items.length * specs.length - missing.length,
        itemCount: items.length,
      };
    }

    const fields = extractOne(source, specs, behaviour, missing);
    return {
      success: true,
      fields,
      items: [fields],
      missing,
      foundCount: specs.length - missing.length,
      itemCount: 1,
    };
  } catch (error) {
    return failed(`Extract fields failed: ${getErrorMessage(error)}`);
  }
}

export async function extractFieldsStep(
  input: ExtractFieldsInput
): Promise<ExtractFieldsResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

extractFieldsStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
