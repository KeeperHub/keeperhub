import {
  findTemplateTokens,
  parseStoredRef,
  sanitizeNodeId,
  splitTemplateRef,
} from "@/lib/workflow/template-ref";

// A stored stray value longer than this is never kept, which bounds the compare.
const KEPT_VALUE_MAX_CHARS = 2000;

type StrayValuePart = { text: string } | { reads: string; path: string };

/**
 * A stray toggle value as the executor resolves it: literal text, and each
 * reference as the output key it reads and the path after the first dot.
 * Undefined when it cannot be kept: a reference by label, or too long.
 */
export function strayValueParts(text: string): StrayValuePart[] | undefined {
  if (text.length > KEPT_VALUE_MAX_CHARS) {
    return;
  }
  const parts: StrayValuePart[] = [];
  let last = 0;
  for (const token of findTemplateTokens(text)) {
    if (!token.body.startsWith("@")) {
      return;
    }
    parts.push({ text: text.slice(last, token.start) });
    const ref = parseStoredRef(token.body);
    parts.push(
      ref
        ? {
            // The executor reads a reference by its trimmed id's output key.
            reads: sanitizeNodeId(ref.nodeId.trim()),
            path: splitTemplateRef(ref.rest).fieldPath.trim(),
          }
        : { text: `{{${token.body}}}` }
    );
    last = token.end;
  }
  parts.push({ text: text.slice(last) });
  return parts;
}

/** Whether a save could keep this stray value, judged from the value alone. */
export function canKeepStrayValue(value: unknown): boolean {
  return (
    typeof value === "number" ||
    (typeof value === "string" && strayValueParts(value) !== undefined)
  );
}
