// High-signal prompt-injection markers. These target phrases that have no
// legitimate use in a workflow description but are common in injection attempts.
// Generic imperatives like "you must" or "always" are intentionally NOT stripped
// because they appear in normal product copy ("You must provide an API key").
const INSTRUCTION_PATTERNS = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|preceding) (?:instructions?|prompts?|messages?|rules?)\b/gi,
  /\bdisregard (?:all |any |the )?(?:previous|prior|above|preceding) (?:instructions?|prompts?|messages?|rules?)\b/gi,
  /\bforget (?:all |any |the )?(?:previous|prior|above|preceding) (?:instructions?|prompts?|messages?|rules?)\b/gi,
  /<\/?(?:system|user|assistant|instructions?)>/gi,
  /\[\/?(?:system|user|assistant|instructions?)\]/gi,
  /\bsystem prompt\b/gi,
  /\bnew instructions?:/gi,
  /\boverride (?:previous |prior |all )?instructions?\b/gi,
] as const;

// Default cap mirrors the legacy behaviour for callers that don't pass an
// option (workflow GET, MCP catalog, OpenAPI). Surfaces that need to render
// the full description in a modal/page can pass a higher cap (or 0 to skip).
const DEFAULT_MAX_LENGTH = 200;

type SanitizeOptions = {
  maxLength?: number;
};

export function sanitizeDescription(
  raw: string,
  options?: SanitizeOptions
): string {
  if (!raw) {
    return "";
  }

  let result = raw;

  // Strip markdown: headers (#, ##, etc.)
  result = result.replace(/^#{1,6}\s*/gm, "");

  // Strip bold (**text** and __text__)
  result = result.replace(/\*\*(.*?)\*\*/g, "$1");
  result = result.replace(/__(.*?)__/g, "$1");

  // Strip italic (*text* and _text_) — single markers only
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/_([^_]+)_/g, "$1");

  // Strip inline code backticks
  result = result.replace(/`([^`]*)`/g, "$1");

  // Strip link syntax [text](url) -> text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Strip bullet chars at line start (- or *)
  result = result.replace(/^[-*]\s*/gm, "");

  // Remove instruction-like phrases
  for (const pattern of INSTRUCTION_PATTERNS) {
    result = result.replace(pattern, "");
  }

  // Collapse multiple whitespace and newlines into single spaces
  result = result.replace(/\s+/g, " ");

  // Trim leading/trailing whitespace
  result = result.trim();

  // If the original string started with an uppercase letter but the transformed
  // result starts with lowercase (due to instruction phrase removal), re-capitalize.
  if (
    result.length > 0 &&
    raw.length > 0 &&
    raw[0] === raw[0].toUpperCase() &&
    raw[0] !== raw[0].toLowerCase() &&
    result[0] === result[0].toLowerCase()
  ) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
  if (maxLength > 0 && result.length > maxLength) {
    result = result.slice(0, maxLength);
  }

  return result;
}
