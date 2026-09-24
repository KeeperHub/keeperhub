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
 * #2004: the same principle extended to the flag's *place*. A `simulate`
 * anywhere the route does not read it -- the query string, the body of a
 * route with no dry-run support, or a nested object that reaches a write
 * (`config` on /api/execute/node, `action` on check-and-execute) -- is a
 * 400 instead of being dropped while the route broadcasts for real. A
 * route either honours a dry run or refuses one; it never accepts the
 * flag and broadcasts.
 *
 * `simulate: false` (and `?simulate=false`) is the one value accepted in
 * those places: it asks for a real execution, which is what every such
 * route performs, so there is no dry run to lose. Every other value,
 * `true` and mistyped values alike, is refused.
 *
 * tests/integration/execute-simulate-invariant.test.ts enumerates the
 * routes from the filesystem and fails when a route has not declared (and
 * wired) its side.
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

function simulateUnsupportedResponse(
  error: string,
  field = "simulate"
): NextResponse {
  return NextResponse.json(
    { error, field, code: "unsupported_param" },
    { status: HttpStatus.BAD_REQUEST }
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A `simulate` key in a place the route does not read is refused unless it is
// exactly `false`, which asks for the real execution the route performs.
function carriesRefusedSimulate(value: unknown): boolean {
  return (
    isPlainObject(value) && "simulate" in value && value.simulate !== false
  );
}

/**
 * Reject a `simulate` query parameter on any /api/execute/* route (#2004).
 *
 * The query string was never honoured, but silently ignoring it made "I asked
 * for a dry run" and "spend real funds" indistinguishable on the wire -- the
 * same hazard as a flag of the wrong type, just in the wrong place. The key
 * is matched case-insensitively, because `?SIMULATE=true` carries the same
 * intent; only the exact value `false` passes. Other query parameters are
 * untouched.
 *
 * Returns the 400 response, or null to proceed -- the `NextResponse | null`
 * guard convention used by requireScope and requireWallet.
 */
export function rejectSimulateQuery(request: Request): NextResponse | null {
  for (const [key, value] of new URL(request.url).searchParams) {
    if (key.toLowerCase() === "simulate" && value !== "false") {
      return simulateUnsupportedResponse(
        `\`simulate\` is not accepted as a query parameter. Pass it in the JSON body instead; a body dry run is honoured by ${DRY_RUN_ROUTES} and refused by every other /api/execute/* route.`
      );
    }
  }
  return null;
}

/**
 * Refuse a `simulate` in the body of a route with no dry-run support (#2004,
 * the refusal branch of item 1).
 *
 * On these routes the flag used to fall through as an unknown field and the
 * route broadcast for real -- the exact "accepted the flag and broadcast"
 * shape the simulate invariant forbids. `container` names a nested object the
 * route passes to the step (`config` on /api/execute/node), where a caller
 * writing step parameters is as likely to put the flag as at the top level.
 *
 * Call it before the idempotency key is reserved so a refused request
 * consumes no execution and leaves no lock to release.
 */
export function refuseSimulateBody(
  body: unknown,
  container?: string
): NextResponse | null {
  let target = body;
  if (container !== undefined) {
    target = isPlainObject(body) ? body[container] : undefined;
  }
  if (!carriesRefusedSimulate(target)) {
    return null;
  }
  return simulateUnsupportedResponse(
    `\`simulate\` is not supported on this route: it has no dry-run mode, and a request is executed as sent. Dry runs are honoured by ${DRY_RUN_ROUTES}.`,
    container === undefined ? "simulate" : `${container}.simulate`
  );
}

/**
 * Refuse a `simulate` nested inside `container` on a route that honours the
 * flag only at the top level of the body (#2004). check-and-execute reads
 * `body.simulate` and nothing else, so `{ action: { simulate: true } }` used
 * to broadcast the action -- the flag was in the place its docs describe it
 * acting on, not the place the route reads it.
 */
export function rejectNestedSimulate(
  body: Record<string, unknown>,
  container: string
): NextResponse | null {
  if (!carriesRefusedSimulate(body[container])) {
    return null;
  }
  return simulateUnsupportedResponse(
    `\`simulate\` is read only at the top level of the request body, not inside \`${container}\`. Move it to the top level to dry-run the request.`,
    `${container}.simulate`
  );
}
