/**
 * `%` and `_` are LIKE wildcards, so a search term carrying either silently
 * widens the match: `my_workflow` would also match `myXworkflow`, and `100%`
 * would match every row. The term is bound as a parameter either way, so this
 * is a correctness fix rather than an injection one.
 *
 * Postgres already defaults LIKE's escape character to a backslash, but the
 * callers spell `ESCAPE '\'` out so a pattern built here does not silently
 * depend on that default.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}
