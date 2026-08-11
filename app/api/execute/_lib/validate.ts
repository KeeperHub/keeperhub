import type { z } from "zod";
import {
  checkAndExecuteInputSchema,
  contractCallInputSchema,
  firstSchemaError,
  tokenFieldsSchema,
  transferInputSchema,
} from "./schemas";
import type { ExecuteErrorResponse } from "./types";

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: ExecuteErrorResponse };

// Run a body through a Zod schema, mapping a failure back to the route's
// stable { error, field, details } contract (KEEP-828). The non-object case is
// reported as "Request body is required" to match the pre-Zod behavior.
function runSchema(body: unknown, schema: z.ZodType): ValidationResult {
  if (!body || typeof body !== "object") {
    return { valid: false, error: { error: "Request body is required" } };
  }
  const result = schema.safeParse(body);
  if (result.success) {
    return { valid: true };
  }
  return { valid: false, error: firstSchemaError(result.error) };
}

export function validateTransferInput(body: unknown): ValidationResult {
  return runSchema(body, transferInputSchema);
}

export function validateContractCallInput(body: unknown): ValidationResult {
  return runSchema(body, contractCallInputSchema);
}

export function validateTokenFields(
  body: Record<string, unknown>
): ValidationResult {
  return runSchema(body, tokenFieldsSchema);
}

export function validateCheckAndExecuteInput(body: unknown): ValidationResult {
  return runSchema(body, checkAndExecuteInputSchema);
}
