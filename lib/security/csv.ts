const CSV_SPECIAL = /[",\n\r]/;
// Leading characters a spreadsheet app (Excel, Sheets) interprets as the start
// of a formula. A cell beginning with one of these can execute on open -- the
// classic CSV injection vector for exported, attacker-influenced text.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Render a value as a single safe CSV cell:
 * - neutralizes formula injection by prefixing a leading =,+,-,@,tab,CR with a
 *   single quote so the value renders as literal text;
 * - quotes + doubles embedded quotes when the cell contains a comma, quote, or
 *   newline.
 */
export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }
  if (CSV_SPECIAL.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
