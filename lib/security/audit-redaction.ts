/**
 * Server-side redaction for the audit `diff` payload. The audit write contract
 * already asks callers to curate before/after, but redaction must not depend on
 * every call site getting that right: this strips secret-looking values before
 * the diff leaves the server, so the wire response can never carry a token even
 * if a future audit call passes one. Display-side masking is only a backstop --
 * the authoritative redaction happens here.
 */

// Field names whose values must never be returned. `keyPrefix` is intentionally
// NOT matched: it is a non-secret prefix used to identify a key in the UI.
export const SENSITIVE_FIELD =
  /(?:^|[_.])(?:token|secret|password|privatekey|private_key|mnemonic|seed|hash|apikey)(?:[_.]|$)|^key$/i;

const REDACTED = "[redacted]";

type DiffChange = {
  kind?: string;
  path?: Array<string | number>;
  lhs?: unknown;
  rhs?: unknown;
};

// Recursively mask any sensitive-named keys inside an object/array value so a
// whole-object create/delete diff can't leak a nested secret either.
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SENSITIVE_FIELD.test(key) ? REDACTED : redactValue(nested);
    }
    return out;
  }
  return value;
}

function redactChange(change: unknown): unknown {
  if (!change || typeof change !== "object") {
    return change;
  }
  const c = change as DiffChange;
  const field = String(c.path?.at(-1) ?? "");
  if (SENSITIVE_FIELD.test(field)) {
    return {
      ...c,
      lhs: c.lhs === undefined ? undefined : REDACTED,
      rhs: c.rhs === undefined ? undefined : REDACTED,
    };
  }
  return { ...c, lhs: redactValue(c.lhs), rhs: redactValue(c.rhs) };
}

/** Redact secret-looking fields from a stored deep-diff before returning it. */
export function redactAuditDiff(diff: unknown): unknown {
  if (diff === null || diff === undefined) {
    return diff;
  }
  if (Array.isArray(diff)) {
    return diff.map(redactChange);
  }
  return redactValue(diff);
}
