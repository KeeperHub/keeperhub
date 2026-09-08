/**
 * Config key and helpers for persisting address-book bookmark selection per input
 * in node config (field key -> bookmark ID).
 */

export const ADDRESS_BOOK_SELECTION_KEY = "addressBookSelection";

export function parseAddressBookSelection(
  config: Record<string, unknown>
): Record<string, string> {
  const raw = config[ADDRESS_BOOK_SELECTION_KEY];
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") {
          result[k] = v;
        }
      }
      return result;
    }
  } catch {
    // ignore
  }
  return {};
}
