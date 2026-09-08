import "server-only";

/**
 * Body parsing for the policy routes.
 *
 * Validation of the document's meaning belongs to the compiler; this only
 * checks the envelope is the right shape so the compiler receives something it
 * can report on properly.
 */

import { NextResponse } from "next/server";
import type { PolicyDocument } from "@/lib/policy";
import { POLICY_SCHEMA_VERSION } from "@/lib/policy";

export type ParsedPolicyBody =
  | { ok: true; document: PolicyDocument; changeDelayHours: number }
  | { ok: false; response: NextResponse };

function bad(error: string, code = "invalid_body"): ParsedPolicyBody {
  return {
    ok: false,
    response: NextResponse.json({ error, code }, { status: 400 }),
  };
}

const MAX_CHANGE_DELAY_HOURS = 24 * 14;

export async function parsePolicyBody(
  request: Request
): Promise<ParsedPolicyBody> {
  const body = (await request.json().catch(() => null)) as {
    document?: unknown;
    changeDelayHours?: unknown;
  } | null;

  if (!body || typeof body !== "object") {
    return bad("Request body must be a JSON object");
  }

  const document = body.document;
  if (!document || typeof document !== "object") {
    return bad("A `document` object is required");
  }

  const doc = document as Partial<PolicyDocument>;
  if (typeof doc.name !== "string" || doc.name.trim() === "") {
    return bad("The policy needs a name");
  }
  if (!Array.isArray(doc.manages)) {
    return bad("`manages` must be an array naming what this policy governs");
  }
  if (!Array.isArray(doc.statements)) {
    return bad("`statements` must be an array");
  }

  let changeDelayHours = 0;
  if (body.changeDelayHours !== undefined) {
    const raw = Number(body.changeDelayHours);
    if (!Number.isInteger(raw) || raw < 0 || raw > MAX_CHANGE_DELAY_HOURS) {
      return bad(
        `\`changeDelayHours\` must be a whole number of hours between 0 and ${MAX_CHANGE_DELAY_HOURS}`
      );
    }
    changeDelayHours = raw;
  }

  return {
    ok: true,
    document: {
      ...(doc as PolicyDocument),
      // The stored document always carries the version this build wrote, so a
      // later reader can tell what it is looking at.
      schemaVersion: doc.schemaVersion ?? POLICY_SCHEMA_VERSION,
      enforcement: doc.enforcement ?? "monitor",
      name: doc.name.trim(),
    },
    changeDelayHours,
  };
}
