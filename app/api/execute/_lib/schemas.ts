import { z } from "zod";
import { MAX_SEQUENCE_CALLS } from "@/lib/execute/simulate-sequence-limits";
import { EVM_ADDRESS_RE } from "@/lib/web3/address";
import { readErrorAbiDocuments } from "@/lib/web3/extra-error-abis";
import { isValidOperator, VALID_OPERATORS } from "./condition";
import { selectorOf } from "./raw-calldata";
import type { ExecuteErrorResponse } from "./types";

/**
 * Zod schemas backing the /api/execute/* input validators (KEEP-828).
 *
 * The execute routes have a stable error contract (`{ error, field, details }`
 * with field-specific categories) that callers and tests depend on. Rather
 * than surface Zod's default issue shape, each schema carries the exact
 * ExecuteErrorResponse on the custom issue's `params`; `firstSchemaError`
 * reads it back so the public contract is byte-for-byte preserved while the
 * validation itself now runs through Zod's safeParse at the boundary.
 */

const MAX_PRIORITY_FEE_GWEI = 10_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// KEEP-490: chainId is canonical; network is a deprecated alias. Either counts
// as present when it carries a numeric chainId or a non-empty string.
function hasChainInput(record: Record<string, unknown>): boolean {
  if (typeof record.chainId === "number") {
    return true;
  }
  return isNonEmptyString(record.chainId) || isNonEmptyString(record.network);
}

// KEEP-1927: functionName is canonical on direct-exec routes; abiFunction is
// the workflow web3 action node's name for the same value. Either counts as
// present. A mismatched pair is caller error rather than something to resolve
// for them: this endpoint broadcasts, and two names that are both in the ABI
// (e.g. "transfer" vs "transferFrom") describe two different transactions,
// only one of which is what the caller meant.
function hasFunctionNameInput(record: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(record.functionName) ||
    isNonEmptyString(record.abiFunction)
  );
}

function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value);
}

// Conflict is keyed on the keys being present, not on their values being
// usable strings, because the contract-call route fills functionName in from
// abiFunction under the same test. A functionName the route cannot use ("" or
// a non-string) is still the caller's stated intent, so it conflicts with a
// differing abiFunction instead of being quietly overwritten.
function functionNameConflict(
  record: Record<string, unknown>
): ExecuteErrorResponse | null {
  if (!("functionName" in record && "abiFunction" in record)) {
    return null;
  }
  const functionName = trimmedText(record.functionName);
  const abiFunction = trimmedText(record.abiFunction);
  if (functionName === abiFunction) {
    return null;
  }
  return {
    error: "Conflicting field values",
    field: "abiFunction",
    details: `functionName and abiFunction disagree ('${functionName}' vs '${abiFunction}'); send one, or the same value in both. functionName is canonical.`,
  };
}

// A dry run of several calls in order. The sequence replaces the single
// top-level call rather than joining it, so the ordinary shape is untouched.
function hasCallSequenceInput(record: Record<string, unknown>): boolean {
  return "calls" in record;
}

function callFieldError(
  index: number,
  field: string,
  details: string
): ExecuteErrorResponse {
  return {
    error: "Invalid field value",
    field: `calls[${index}].${field}`,
    details,
  };
}

function callSequenceError(
  record: Record<string, unknown>
): ExecuteErrorResponse | null {
  const calls = record.calls;
  if (!Array.isArray(calls)) {
    return {
      error: "Invalid field type",
      field: "calls",
      details:
        "calls must be an array of { contractAddress, functionName, ... }",
    };
  }
  if (calls.length === 0) {
    return {
      error: "Invalid field value",
      field: "calls",
      details: "calls must contain at least one call",
    };
  }
  if (calls.length > MAX_SEQUENCE_CALLS) {
    return {
      error: "Invalid field value",
      field: "calls",
      details: `calls must contain at most ${MAX_SEQUENCE_CALLS} calls`,
    };
  }
  for (const [index, call] of calls.entries()) {
    if (!isNonNullObject(call)) {
      return callFieldError(index, "", "each call must be an object");
    }
    if (!isNonEmptyString(call.contractAddress)) {
      return callFieldError(
        index,
        "contractAddress",
        "contractAddress is required and must be a non-empty string"
      );
    }
    if (!isNonEmptyString(call.functionName)) {
      return callFieldError(
        index,
        "functionName",
        "functionName is required and must be a non-empty string"
      );
    }
    if ("functionArgs" in call && typeof call.functionArgs !== "string") {
      return callFieldError(
        index,
        "functionArgs",
        "functionArgs must be a JSON string when provided"
      );
    }
    if ("abi" in call && typeof call.abi !== "string") {
      return callFieldError(
        index,
        "abi",
        "abi must be a JSON string when provided"
      );
    }
    if ("value" in call && typeof call.value !== "string") {
      return callFieldError(
        index,
        "value",
        "value must be a decimal string in ether units when provided"
      );
    }
  }
  return null;
}

// Checked here because a missing function key short-circuits this schema, so
// nothing downstream would ever see `data`.
function hasRawCalldataInput(record: Record<string, unknown>): boolean {
  return "data" in record;
}

// Same rule as functionNameConflict: keyed on the keys being present, because
// the route would otherwise decode one and quietly drop the other.
function rawCalldataConflict(
  record: Record<string, unknown>
): ExecuteErrorResponse | null {
  const named = "functionName" in record ? "functionName" : "abiFunction";
  if (!(named in record)) {
    return null;
  }
  return {
    error: "Conflicting field values",
    field: "data",
    details: `data and ${named} describe the same call twice; send raw calldata in data, or the function key and functionArgs, not both.`,
  };
}

function rawCalldataError(
  record: Record<string, unknown>
): ExecuteErrorResponse | null {
  const data = record.data;
  if (typeof data !== "string") {
    return {
      error: "Invalid field type",
      field: "data",
      details: "data must be a 0x-prefixed hex string",
    };
  }
  const selector = selectorOf(data);
  if (typeof selector !== "string") {
    return {
      error: "Invalid field value",
      field: "data",
      details: selector.error,
    };
  }
  return null;
}

function requiredFieldError(field: string): ExecuteErrorResponse {
  return {
    error: "Missing required field",
    field,
    details: `${field} is required and must be a non-empty string`,
  };
}

// #2430: extra error sources for the decode path. The bounds and the shape
// checks live with the decoder (`lib/web3/extra-error-abis.ts`) so the field a
// route accepts is the field the decoder can use; this only maps the refusal
// onto the execute error contract.
function errorAbisFieldError(value: unknown): ExecuteErrorResponse | null {
  const result = readErrorAbiDocuments(value);
  if (result.ok) {
    return null;
  }
  return {
    error: result.message,
    field: "errorAbis",
    details: result.details,
  };
}

const chainFieldError: ExecuteErrorResponse = {
  error: "Missing required field",
  field: "chainId",
  details:
    "chainId is required (network is accepted as a deprecated alias). Pass a numeric chain ID or a known chain name.",
};

function addError(ctx: z.RefinementCtx, error: ExecuteErrorResponse): void {
  ctx.addIssue({ code: "custom", message: error.error, params: error });
}

/** Read the ExecuteErrorResponse carried on the first issue's params. */
export function firstSchemaError(error: z.ZodError): ExecuteErrorResponse {
  const issue = error.issues[0] as
    | { params?: ExecuteErrorResponse }
    | undefined;
  return issue?.params ?? { error: "Invalid request body" };
}

// Every schema operates on an already-confirmed object (callers guard the
// non-object case to keep the "Request body is required" message), so a loose
// record is the right base.
const objectBase = z.record(z.string(), z.unknown());

export const transferInputSchema = objectBase.superRefine((record, ctx) => {
  if (!hasChainInput(record)) {
    addError(ctx, chainFieldError);
    return;
  }
  if (!isNonEmptyString(record.recipientAddress)) {
    addError(ctx, requiredFieldError("recipientAddress"));
    return;
  }
  if (!isNonEmptyString(record.amount)) {
    addError(ctx, requiredFieldError("amount"));
  }
});

export const tokenFieldsSchema = objectBase.superRefine((record, ctx) => {
  if (
    "tokenAddress" in record &&
    (typeof record.tokenAddress !== "string" ||
      !EVM_ADDRESS_RE.test(record.tokenAddress))
  ) {
    addError(ctx, {
      error: "Invalid field type",
      field: "tokenAddress",
      details: "tokenAddress must be a valid hex address (0x + 40 hex chars)",
    });
    return;
  }

  if ("tokenConfig" in record) {
    const isValidString =
      typeof record.tokenConfig === "string" &&
      record.tokenConfig.trim() !== "";
    const isValidObject = isNonNullObject(record.tokenConfig);
    if (!(isValidString || isValidObject)) {
      addError(ctx, {
        error: "Invalid field type",
        field: "tokenConfig",
        details: "tokenConfig must be a string or a plain object",
      });
    }
  }
});

function priorityFeeError(value: unknown): ExecuteErrorResponse | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return {
      error: "Invalid field type",
      field: "priorityFeeGwei",
      details: "priorityFeeGwei must be a non-empty decimal string in gwei",
    };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      error: "Invalid field value",
      field: "priorityFeeGwei",
      details: "priorityFeeGwei must be a finite positive decimal in gwei",
    };
  }
  if (parsed > MAX_PRIORITY_FEE_GWEI) {
    return {
      error: "Invalid field value",
      field: "priorityFeeGwei",
      details: `priorityFeeGwei must not exceed ${MAX_PRIORITY_FEE_GWEI} gwei`,
    };
  }
  return null;
}

export const contractCallInputSchema = objectBase.superRefine((record, ctx) => {
  if (hasCallSequenceInput(record)) {
    if (!hasChainInput(record)) {
      addError(ctx, chainFieldError);
      return;
    }
    const sequenceError = callSequenceError(record);
    if (sequenceError) {
      addError(ctx, sequenceError);
      return;
    }
    const sequenceFeeError = priorityFeeError(record.priorityFeeGwei);
    if (sequenceFeeError) {
      addError(ctx, sequenceFeeError);
    }
    return;
  }
  if (!isNonEmptyString(record.contractAddress)) {
    addError(ctx, requiredFieldError("contractAddress"));
    return;
  }
  if (!hasChainInput(record)) {
    addError(ctx, chainFieldError);
    return;
  }
  if (hasRawCalldataInput(record)) {
    const conflict = rawCalldataConflict(record);
    if (conflict) {
      addError(ctx, conflict);
      return;
    }
    const dataError = rawCalldataError(record);
    if (dataError) {
      addError(ctx, dataError);
      return;
    }
  } else if (!hasFunctionNameInput(record)) {
    addError(ctx, requiredFieldError("functionName"));
    return;
  }
  const conflict = functionNameConflict(record);
  if (conflict) {
    addError(ctx, conflict);
    return;
  }
  if ("functionArgs" in record && typeof record.functionArgs !== "string") {
    addError(ctx, {
      error: "Invalid field type",
      field: "functionArgs",
      details: "functionArgs must be a JSON string when provided",
    });
    return;
  }
  const feeError = priorityFeeError(record.priorityFeeGwei);
  if (feeError) {
    addError(ctx, feeError);
    return;
  }
  const errorAbisError = errorAbisFieldError(record.errorAbis);
  if (errorAbisError) {
    addError(ctx, errorAbisError);
  }
});

function conditionError(condition: unknown): ExecuteErrorResponse | null {
  if (!isNonNullObject(condition)) {
    return {
      error: "Missing required field",
      field: "condition",
      details: "condition must be an object with operator and value",
    };
  }
  if (!isValidOperator(condition.operator)) {
    return {
      error: "Invalid condition operator",
      field: "condition.operator",
      details: `Valid operators: ${VALID_OPERATORS.join(", ")}`,
    };
  }
  if (!isNonEmptyString(condition.value)) {
    return {
      error: "Missing required field",
      field: "condition.value",
      details: "condition.value is required and must be a non-empty string",
    };
  }
  try {
    BigInt(condition.value);
  } catch {
    return {
      error: "Invalid field value",
      field: "condition.value",
      details: "condition.value must be an integer-compatible string",
    };
  }
  return null;
}

function actionError(action: unknown): ExecuteErrorResponse | null {
  if (!isNonNullObject(action)) {
    return {
      error: "Missing required field",
      field: "action",
      details: "action must be an object with contractAddress and functionName",
    };
  }
  if (!isNonEmptyString(action.contractAddress)) {
    return requiredFieldError("action.contractAddress");
  }
  if (!isNonEmptyString(action.functionName)) {
    return requiredFieldError("action.functionName");
  }
  return null;
}

export const checkAndExecuteInputSchema = objectBase.superRefine(
  (record, ctx) => {
    if (!isNonEmptyString(record.contractAddress)) {
      addError(ctx, requiredFieldError("contractAddress"));
      return;
    }
    if (!hasChainInput(record)) {
      addError(ctx, chainFieldError);
      return;
    }
    if (!isNonEmptyString(record.functionName)) {
      addError(ctx, requiredFieldError("functionName"));
      return;
    }
    const condError = conditionError(record.condition);
    if (condError) {
      addError(ctx, condError);
      return;
    }
    const actError = actionError(record.action);
    if (actError) {
      addError(ctx, actError);
      return;
    }
    const errorAbisError = errorAbisFieldError(record.errorAbis);
    if (errorAbisError) {
      addError(ctx, errorAbisError);
    }
  }
);
