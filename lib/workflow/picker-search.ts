const WHITESPACE_PATTERN = /\s+/u;

/** Case-insensitive match of every word in the query against the name. */
export function matchesWorkflowSearch(name: string, query: string): boolean {
  const words = query
    .trim()
    .toLowerCase()
    .split(WHITESPACE_PATTERN)
    .filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = name.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
