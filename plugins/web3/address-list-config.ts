// Contract Addresses lists, read alike by Batch Read Contract and Query Contract
// Events. Free of ethers so the plugin definitions can run it at save time; the
// steps pass ethers' checksum check when they run.

import { stripControlChars } from "@/lib/utils/control-chars";
import { EVM_ADDRESS_RE } from "@/lib/web3/address";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";
import { readsFromAddressList } from "./batch-read-modes";

const ADDRESS_LIST_LABEL = "Contract Addresses";
export const MAX_LIST_ADDRESSES = 5000;
const MAX_LIST_TEXT_BYTES = 1_048_576;

const ADDRESS_LIST_FIELD = "contractAddresses";
const MAX_SHOWN_LENGTH = 60;
const BARE_HEX_ADDRESS_RE = /^[0-9a-fA-F]{40}$/;
const WHITESPACE_RE = /\s/;
const LINE_BREAK_RE = /[\t\n\r]/g;
const EN_US = "en-US";

/** A list read from a field; only an empty list may be softened by Fail workflow on error. */
type ListRead =
  | { success: true; entries: unknown[] }
  | { success: false; error: string; emptyList?: true };

type ListSpec = {
  label: string;
  // A typed list the message offers as an example, e.g. ["0xabc..."].
  example: string;
  maxEntries: number;
  // What the entry limit counts, e.g. "calls per run".
  limitUnit: string;
  // What to do about a list over a limit.
  nextStep: string;
};

const ADDRESS_LIST_SPEC: ListSpec = {
  label: ADDRESS_LIST_LABEL,
  example: '["0xabc..."]',
  maxEntries: MAX_LIST_ADDRESSES,
  limitUnit: "addresses per node",
  nextStep: "Filter the list first or split it across several nodes.",
};

const REPLACEMENT_CHAR = String.fromCodePoint(0xff_fd);

/** User text shortened for a message, hidden and control characters shown as U+FFFD. */
export function echo(text: string, max = MAX_SHOWN_LENGTH): string {
  // Line breaks and tabs read as spaces; other hidden characters are marked.
  const shown = stripControlChars(text.replace(LINE_BREAK_RE, " "), {
    replacement: REPLACEMENT_CHAR,
  });
  if (shown.length <= max) {
    return shown;
  }
  // Not between the two halves of a surrogate pair.
  const code = shown.charCodeAt(max - 1);
  const end = code >= 0xd8_00 && code <= 0xdb_ff ? max - 1 : max;
  return `${shown.slice(0, end)}...`;
}

export function describeKind(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value}`;
}

export function count(n: number): string {
  return n.toLocaleString(EN_US);
}

// A list passed as a value may hold a bigint, which JSON.stringify refuses.
export function jsonText(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item
  );
}

function textBytes(value: unknown): number {
  const text = typeof value === "string" ? value : jsonText(value);
  return new TextEncoder().encode(text ?? "").length;
}

// Rounded up, so a value just over a limit never reads as the limit itself.
export function megabytes(bytes: number): string {
  return (Math.ceil((bytes / 1_048_576) * 10) / 10).toFixed(1);
}

/** Why `value` is over the 1 MB text limit, or undefined when it is not. */
export function textSizeError(
  value: unknown,
  label: string,
  nextStep: string
): string | undefined {
  let bytes: number;
  try {
    bytes = textBytes(value);
  } catch {
    // JSON.stringify gives up on a value nested too deeply to measure.
    return `${label} is nested too deeply to read. Check the node that produces it.`;
  }
  return bytes > MAX_LIST_TEXT_BYTES
    ? `${label} is ${megabytes(bytes)} MB; the limit is 1 MB. ${nextStep}`
    : undefined;
}

function failed(error: string): ListRead {
  return { success: false, error };
}

/**
 * Read a list field (resolved template text or a native array) into its
 * entries, enforcing the size and length caps before anything is called.
 */
export function readJsonList(raw: unknown, spec: ListSpec): ListRead {
  const { label } = spec;
  let parsed: unknown = raw ?? "";
  const singleValue = `${label} got a single value, not a list. To give one, put it in brackets, like ${spec.example}. If it comes from Encode / Decode, a one-entry array comes back as a plain value; see the docs.`;
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (text === "") {
      return failed(
        `${label} is missing: the field is blank or its reference resolved to nothing. Check the reference and the node that produces it.`
      );
    }
    const tooBig = textSizeError(text, label, spec.nextStep);
    if (tooBig) {
      return failed(tooBig);
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      // Several values in text: commas, or spaces or lines between them.
      const looksLikeList =
        text.startsWith("[") || text.includes(",") || WHITESPACE_RE.test(text);
      return failed(
        looksLikeList
          ? `${label} is not a JSON array. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like ${spec.example}.`
          : singleValue
      );
    }
  } else if (Array.isArray(parsed)) {
    const tooBig = textSizeError(parsed, label, spec.nextStep);
    if (tooBig) {
      return failed(tooBig);
    }
  }
  if (
    typeof parsed === "string" ||
    typeof parsed === "number" ||
    typeof parsed === "boolean"
  ) {
    return failed(singleValue);
  }
  if (!Array.isArray(parsed)) {
    return failed(
      `${label} must be an array, got ${describeKind(parsed)}. Point it at the array itself, e.g. {{@node1:Label.result.items}}.`
    );
  }
  if (parsed.length === 0) {
    return {
      success: false,
      error: `${label} is empty. Check the node that produces it.`,
      emptyList: true,
    };
  }
  if (parsed.length > spec.maxEntries) {
    return failed(
      `${label} has ${count(parsed.length)} entries; the limit is ${count(spec.maxEntries)} ${spec.limitUnit}. ${spec.nextStep}`
    );
  }
  return { success: true, entries: parsed };
}

/**
 * Why a Contract Addresses entry is not an address, or undefined when it is.
 * The list takes 0x and 40 hex characters only, as every network these steps
 * run on writes it. `checksumOk` is ethers' check at run time; save time has
 * no ethers and leaves checksums to the run.
 */
function addressEntryError(
  index: number,
  entry: unknown,
  checksumOk: (address: string) => boolean = () => true
): string | undefined {
  const at = `${ADDRESS_LIST_LABEL} entry ${index + 1}`;
  if (typeof entry !== "string") {
    return `${at} must be an address string, got ${describeKind(entry)}. Point the list at the addresses themselves, e.g. ["0xabc..."].`;
  }
  const text = entry.trim();
  const shown = `"${echo(text)}"`;
  if (BARE_HEX_ADDRESS_RE.test(text)) {
    return `${at} has no 0x in front: ${shown}. Write it as 0x followed by the 40 hex characters; if the source leaves 0x off every address, add it in an earlier node.`;
  }
  if (!EVM_ADDRESS_RE.test(text)) {
    return notAnAddressError(at, shown);
  }
  if (!checksumOk(text)) {
    return badChecksumError(at, text);
  }
  return;
}

export function notAnAddressError(at: string, shown: string): string {
  return `${at} is not a valid address: ${shown}. Use a 0x address with 40 hex characters.`;
}

export function spacedAddressError(at: string, text: string): string {
  return `${at} is not a valid address: "${echo(text)}". Remove the spaces around it.`;
}

export function badChecksumError(at: string, text: string): string {
  return `${at} has a bad checksum: "${echo(text)}". Use the address exactly as published, or in all lower case.`;
}

/** The trimmed addresses in list order, repeats kept, or why the list fails. */
export function readAddressList(
  raw: unknown,
  checksumOk: (address: string) => boolean
): { success: true; addresses: string[] } | Exclude<ListRead, { success: true }> {
  const list = readJsonList(raw, ADDRESS_LIST_SPEC);
  if (!list.success) {
    return list;
  }
  const addresses: string[] = [];
  for (const [index, entry] of list.entries.entries()) {
    const error = addressEntryError(index, entry, checksumOk);
    if (error) {
      return { success: false, error };
    }
    addresses.push((entry as string).trim());
  }
  return { success: true, addresses };
}

/** Save-time check of a typed list; checksums are checked when the step runs. */
function checkTypedAddressList(
  raw: unknown
): { field: string; message: string } | undefined {
  // A reference, or a typed array holding one, is resolved and checked at run time.
  const referenced = Array.isArray(raw)
    ? raw.some(valueContainsTemplate)
    : valueContainsTemplate(raw);
  if (raw === undefined || raw === "" || referenced) {
    return;
  }
  const list = readAddressList(raw, () => true);
  return list.success
    ? undefined
    : { field: ADDRESS_LIST_FIELD, message: list.error };
}

export function checkQueryEventsConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  return config.queryMode === "address-list"
    ? checkTypedAddressList(config[ADDRESS_LIST_FIELD])
    : undefined;
}

export function checkBatchReadConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  return readsFromAddressList(config)
    ? checkTypedAddressList(config[ADDRESS_LIST_FIELD])
    : undefined;
}
