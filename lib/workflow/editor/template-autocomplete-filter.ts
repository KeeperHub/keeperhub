/**
 * Pure filter + indexing helpers for the variable-suggestion autocomplete.
 * Lives outside the React component so the matching logic can be unit-tested.
 */

const WHITESPACE_RE = /\s+/;

export type AutocompleteOption = {
  type: "node" | "field";
  nodeId: string;
  nodeName: string;
  field?: string;
  description?: string;
  template: string;
};

export type IndexedAutocompleteOption = AutocompleteOption & {
  /** Pre-lowercased searchable text: nodeName + field + description */
  haystack: string;
};

export function buildHaystack(opt: AutocompleteOption): string {
  return `${opt.nodeName} ${opt.field ?? ""} ${opt.description ?? ""}`.toLowerCase();
}

export function indexOption(
  opt: AutocompleteOption
): IndexedAutocompleteOption {
  return { ...opt, haystack: buildHaystack(opt) };
}

/**
 * Case-insensitive substring match: each whitespace-separated token must
 * appear as a contiguous substring somewhere in the option's haystack.
 *
 * Substring (not subsequence) avoids noisy matches where query characters
 * appear in order but spread across unrelated parts of the option text --
 * e.g., "data.id" would otherwise match "data.triggered" because the chars
 * d-a-t-a-.-i-d all appear in order.
 */
export function filterOptionsByQuery<T extends IndexedAutocompleteOption>(
  options: T[],
  query: string
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return options;
  }
  const tokens = normalized.split(WHITESPACE_RE);
  return options.filter((opt) =>
    tokens.every((token) => opt.haystack.includes(token))
  );
}
