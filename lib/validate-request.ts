import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * Shared request-body validation for sensitive API routes (KEEP-828).
 *
 * Validates untrusted input against a Zod schema at the boundary, before any
 * business logic runs. On failure it returns a ready-to-send 400 response with
 * a flattened list of field errors; on success it returns the parsed, typed
 * data. Routes destructure the result and early-return the response.
 */

export type ValidationOutcome<T> =
  | { success: true; data: T }
  | { success: false; response: NextResponse };

function validationErrorResponse(error: z.ZodError): NextResponse {
  return NextResponse.json(
    { error: "Validation failed", details: z.flattenError(error) },
    { status: 400 }
  );
}

/**
 * Validate an already-parsed value (e.g. a body read earlier in the handler,
 * or params assembled from a URL-encoded form) against a schema.
 */
export function validateData<T extends z.ZodType>(
  data: unknown,
  schema: T
): ValidationOutcome<z.infer<T>> {
  const result = schema.safeParse(data);
  if (!result.success) {
    return { success: false, response: validationErrorResponse(result.error) };
  }
  return { success: true, data: result.data };
}

/**
 * Read and validate a JSON request body against a schema. Returns a 400 for
 * malformed JSON before validation runs.
 */
export async function validateBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<ValidationOutcome<z.infer<T>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      ),
    };
  }
  return validateData(body, schema);
}
