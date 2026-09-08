/**
 * Parse the dry-run flag from a POST /api/execute/* request body.
 *
 * Strict-boolean only:
 *   - body.simulate === true  -> simulate
 *   - body.simulate === false -> broadcast
 *   - body.simulate omitted   -> broadcast
 *   - anything else           -> 400 with a structured error
 *
 * Coercing strings or numbers to a boolean is intentionally not
 * supported: an execute endpoint must have exactly one shape per
 * input, and silently falling through to "spend real funds" because
 * a caller mistyped `"true"` instead of `true` is unsafe.
 *
 * #2004: the same principle extended to the flag's *place*. Every
 * /api/execute/* route rejects a `simulate` query parameter with 400
 * (rejectSimulateQuery), and a route with no dry-run support at all
 * rejects a body `simulate` with 400 (refuseSimulateBody) instead of
 * dropping the field and broadcasting for real. A route either honours
 * a dry run or refuses one -- it never accepts the flag and
 * broadcasts. tests/integration/execute-simulate-invariant.test.ts
 * enumerates the routes from the filesystem and fails when a route
 * has not declared (and wired) its side.
 */

import { NextResponse } from "next/server";
import { HttpStatus } from "@/lib/http-status";

type ParsedSimulateFlag =
  | { ok: true; simulate: boolean }
  | { ok: false; error: string };

export function parseSimulateFlag(
  body: Record<string, unknown>
): ParsedSimulateFlag {
  const value = body.simulate;
  if (value === undefined) {
    return { ok: true, simulate: false };
  }
  if (typeof value !== "boolean") {
    return {
      ok: false,
      error:
        "`simulate` must be a boolean (true or false). Strings, numbers, and other types are rejected.",
    };
  }
  return { ok: true, simulate: value };
}

// The only routes that honour a body dry run. Refusal messages name them so a
// caller holding the flag in the wrong place knows where it belongs. Keep in
// sync with the routes that call parseSimulateFlag.
const DRY_RUN_ROUTES =
  "/api/execute/transfer, /api/execute/contract-call, and /api/execute/check-and-execute";

function simulateUnsupportedResponse(error: string): NextResponse {
  return NextResponse.json(
    { error, field: "simulate", code: "unsupported_param" },
    { status: HttpStatus.BAD_REQUEST }
  );
}

/**
 * Reject a `simulate` query parameter on any /api/execute/* route (#2004).
 *
 * The query string was never honoured, but silently ignoring it made "I asked
 * for a dry run" and "spend real funds" indistinguishable on the wire -- the
 * same hazard as a flag of the wrong type, just in the wrong place. Any
 * `simulate` key is now a 400: `true`, `false`, an empty value, or a
 * mistyped string. Other query parameters are untouched.
 *
 * Returns the 400 response, or null when no `simulate` query parameter is
 * present -- the proceed signal, matching the `NextResponse | null` guard
 * convention used by requireScope and requireWallet.
 */
export function rejectSimulateQuery(request: Request): NextResponse | null {
  if (!new URL(request.url).searchParams.has("simulate")) {
    return null;
  }
  return simulateUnsupportedResponse(
    `\`simulate\` is not accepted as a query parameter. Pass it in the JSON body instead; a body dry run is honoured by ${DRY_RUN_ROUTES} and refused by every other /api/execute/* route.`
  );
}

/**
 * Refuse a `simulate` field in the body of a route with no dry-run support
 * (#2004, the refusal branch of item 1).
 *
 * On these routes the flag used to fall through as an unknown body field and
 * the route broadcast for real -- the exact "accepted the flag and
 * broadcast" shape the simulate invariant forbids. Any value is refused
 * (including the string "true"): a route with no dry-run support has no
 * correct flag shape to accept.
 *
 * Same `NextResponse | null` convention as rejectSimulateQuery. Call it
 * before the idempotency key is reserved so a refused request consumes no
 * execution and leaves no lock to release.
 */
export function refuseSimulateBody(body: unknown): NextResponse | null {
  if (typeof body !== "object" || body === null || !("simulate" in body)) {
    return null;
  }
  return simulateUnsupportedResponse(
    `\`simulate\` is not supported on this route: it executes for real and cannot dry-run. Dry runs are honoured by ${DRY_RUN_ROUTES}.`
  );
}
