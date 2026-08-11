import { z } from "zod";
import { isValidOperator, VALID_OPERATORS } from "./condition";
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

const HEX_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
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

function requiredFieldError(field: string): ExecuteErrorResponse {
  return {
    error: "Missing required field",
    field,
    details: `${field} is required and must be a non-empty string`,
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
      !HEX_ADDRESS_REGEX.test(record.tokenAddress))
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
    }
  }
);
