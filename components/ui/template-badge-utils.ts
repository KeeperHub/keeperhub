// Shared helpers for the template-badge editable surfaces.

import { findStoredRefTokens } from "@/lib/workflow/template-ref";

// Defensive: parent components type `value` as string, but TS-only `as string`
// casts at call sites can leak non-strings (numbers, booleans) to us at
// runtime. internalValue.match() in the badge inputs would throw "match is
// not a function" in that case, blocking the user's edit from propagating
// (KEEP-367).
export function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

// Counts template tokens in a value, coercing non-strings/undefined safely.
// Direct `value.match(...)` calls throw when `value` is undefined (KEEP-366).
export function countTemplateTokens(value: unknown): number {
  return findStoredRefTokens(toStringValue(value)).length;
}
