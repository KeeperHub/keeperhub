// Shape checks for Query Contract Events' Contract Addresses list. Free of
// ethers so the plugin definition can run them at save time.

import { valueContainsTemplate } from "@/lib/workflow/template-ref";

export const MAX_LIST_ADDRESSES = 5000;

const ADDRESS_LIST_FIELD = "contractAddresses";
const ADDRESS_LIST_SHAPE_ERROR =
  "Contract Addresses must be a list of addresses (a JSON array), not a single value or text. Check the node that produces it.";
const ADDRESS_LIST_EMPTY_ERROR =
  "Contract Addresses is empty. Check the node that produces it.";

export type AddressListValue =
  | { success: true; entries: unknown[] }
  | { success: false; error: string; emptyList?: true };

export function readAddressListValue(raw: unknown): AddressListValue {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") {
      return { success: false, error: ADDRESS_LIST_EMPTY_ERROR };
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return { success: false, error: ADDRESS_LIST_SHAPE_ERROR };
    }
  }
  if (value === undefined || value === null) {
    return { success: false, error: ADDRESS_LIST_EMPTY_ERROR };
  }
  if (!Array.isArray(value)) {
    return { success: false, error: ADDRESS_LIST_SHAPE_ERROR };
  }
  if (value.length === 0) {
    return { success: false, error: ADDRESS_LIST_EMPTY_ERROR, emptyList: true };
  }
  if (value.length > MAX_LIST_ADDRESSES) {
    return {
      success: false,
      error: `Contract Addresses has ${value.length} entries, more than the ${MAX_LIST_ADDRESSES} one node can query. Split the list across several nodes.`,
    };
  }
  return { success: true, entries: value };
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The address form the list takes: 0x and 40 hex characters, in any case. */
export function isHexAddress(text: string): boolean {
  return EVM_ADDRESS_RE.test(text);
}

export function badAddressEntryError(index: number, entry: unknown): string {
  return `Contract Addresses entry ${index + 1} is not a valid address: ${JSON.stringify(entry)}. Use a 0x address with 40 hex characters.`;
}

/** Save-time check of a typed list; checksums are checked when the step runs. */
export function checkQueryEventsConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  const raw = config[ADDRESS_LIST_FIELD];
  if (
    config.queryMode !== "address-list" ||
    raw === undefined ||
    raw === "" ||
    valueContainsTemplate(raw)
  ) {
    return;
  }
  const list = readAddressListValue(raw);
  if (!list.success) {
    return { field: ADDRESS_LIST_FIELD, message: list.error };
  }
  for (const [index, entry] of list.entries.entries()) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!isHexAddress(text)) {
      return {
        field: ADDRESS_LIST_FIELD,
        message: badAddressEntryError(index, entry),
      };
    }
  }
  return;
}
