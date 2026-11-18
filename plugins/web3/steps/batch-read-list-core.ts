import { ethers } from "ethers";

export const MAX_TOTAL_CALLS = 5000;
export const MAX_LIST_TEXT_BYTES = 1_048_576;

export const CALLS_FROM_ROWS = "rows";
export const CALLS_FROM_ARGS_LIST = "args-list";
export const CALLS_FROM_ADDRESS_LIST = "address-list";

export const ARGS_LIST_LABEL = "Argument sets";
export const ADDRESS_LIST_LABEL = "Contract addresses";
export const SHARED_ARGS_LABEL = "Arguments";

const MAX_ECHOED_LENGTH = 60;
const EN_US = "en-US";
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SCALAR_TYPE_RE = /^(address|bool|string|bytes\d*|u?int\d*)$/;
const INTEGER_TYPE_RE = /^u?int\d*$/;

export type AbiInput = { name?: string; type: string };
export type ListFunction = { name: string; inputs: AbiInput[] };

export type CallsFrom =
  | typeof CALLS_FROM_ROWS
  | typeof CALLS_FROM_ARGS_LIST
  | typeof CALLS_FROM_ADDRESS_LIST;

/** Absent or blank means rows, so workflows saved before the field run as before. */
export function resolveCallsFrom(value: unknown): CallsFrom {
  if (value === undefined || value === null || value === "") {
    return CALLS_FROM_ROWS;
  }
  if (
    value === CALLS_FROM_ROWS ||
    value === CALLS_FROM_ARGS_LIST ||
    value === CALLS_FROM_ADDRESS_LIST
  ) {
    return value;
  }
  throw new Error(
    `Calls from must be "${CALLS_FROM_ROWS}", "${CALLS_FROM_ARGS_LIST}" or "${CALLS_FROM_ADDRESS_LIST}", got "${echo(String(value))}".`
  );
}

function echo(text: string): string {
  return text.length > MAX_ECHOED_LENGTH
    ? `${text.slice(0, MAX_ECHOED_LENGTH)}...`
    : text;
}

function describeKind(value: unknown): string {
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

function count(n: number): string {
  return n.toLocaleString(EN_US);
}

function plural(n: number, word: string): string {
  return `${count(n)} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Parse a list input (resolved template text or a native array) into its
 * entries, enforcing the size and length caps before anything is called.
 */
export function parseListInput(
  raw: unknown,
  label: string,
  typedExample: string
): unknown[] {
  let parsed: unknown = raw;
  if (raw === undefined || raw === null) {
    parsed = "";
  }
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (text === "") {
      throw new Error(
        `${label} is required. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like ${typedExample}.`
      );
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_LIST_TEXT_BYTES) {
      // Rounded up, so a list just over the limit never reads as "1.0 MB".
      const mb = (Math.ceil((bytes / MAX_LIST_TEXT_BYTES) * 10) / 10).toFixed(1);
      throw new Error(
        `${label} is ${mb} MB; the limit is 1 MB. Filter the list first, e.g. with Filter Array.`
      );
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `${label} is not a JSON array. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like ${typedExample}.`
      );
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${label} must be an array, got ${describeKind(parsed)}. Point it at the array itself, e.g. {{@node1:Label.result.items}}.`
    );
  }
  if (parsed.length === 0) {
    throw new Error(`${label} is empty. Check the node that produces it.`);
  }
  if (parsed.length > MAX_TOTAL_CALLS) {
    throw new Error(
      `${label} has ${count(parsed.length)} entries; the limit is ${count(MAX_TOTAL_CALLS)} calls per run. Split the list across two Batch Read nodes or filter it first.`
    );
  }
  return parsed;
}

/** Every entry must be a 0x address with a valid checksum when mixed case. */
export function addressesFromList(entries: unknown[]): string[] {
  const addresses: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const at = `${ADDRESS_LIST_LABEL} entry ${index + 1}`;
    if (typeof entry !== "string") {
      throw new Error(
        `${at} must be an address string, got ${describeKind(entry)}.`
      );
    }
    const address = entry.trim();
    if (!HEX_ADDRESS_RE.test(address)) {
      throw new Error(
        `${at} is not a valid address: "${echo(entry)}". Each entry must be a 0x address with 40 hex characters.`
      );
    }
    if (!ethers.isAddress(address)) {
      throw new Error(
        `${at} has a bad checksum: "${address}". Use the address exactly as published, or in all lower case.`
      );
    }
    addresses.push(address);
  }
  return addresses;
}

function inputNames(fn: ListFunction): string {
  return fn.inputs
    .map((input, index) => input.name || input.type || `arg${index}`)
    .join(", ");
}

function exampleValue(type: string): string {
  if (type.endsWith("]")) {
    return "[...]";
  }
  if (type === "address" || type.startsWith("bytes")) {
    return '"0x..."';
  }
  if (type === "bool") {
    return "true";
  }
  if (INTEGER_TYPE_RE.test(type)) {
    return "1";
  }
  return '"..."';
}

function exampleEntry(fn: ListFunction): string {
  return `[${fn.inputs.map((input) => exampleValue(input.type)).join(", ")}]`;
}

/** A plain value type, so a bare entry cannot be mistaken for an argument set. */
function takesOneScalar(fn: ListFunction): boolean {
  return fn.inputs.length === 1 && SCALAR_TYPE_RE.test(fn.inputs[0].type);
}

/** A list of argument sets needs a function that takes some. */
export function requireArguments(fn: ListFunction): void {
  if (fn.inputs.length === 0) {
    throw new Error(
      `${fn.name} takes no arguments, so a list of argument sets has nothing to change between calls. To call it on many contracts, set Calls from to "A list of contract addresses".`
    );
  }
}

/**
 * One argument set per entry. An entry is the call's arguments in order; for
 * a function with one plain-typed argument it may also be the bare value.
 */
export function argSetsFromList(
  entries: unknown[],
  fn: ListFunction
): unknown[][] {
  requireArguments(fn);
  const takes = fn.inputs.length;
  const names = inputNames(fn);
  const scalar = takesOneScalar(fn);
  const sets: unknown[][] = [];
  for (const [index, entry] of entries.entries()) {
    const at = `${ARGS_LIST_LABEL} entry ${index + 1}`;
    if (!Array.isArray(entry)) {
      if (scalar) {
        sets.push([entry]);
        continue;
      }
      throw new Error(
        `${at} must be an array of ${plural(takes, "value")} for ${fn.name} (${names}), got ${describeKind(entry)}.`
      );
    }
    if (entry.length !== takes) {
      const bare = scalar ? ", or the bare value" : "";
      throw new Error(
        `${at} has ${plural(entry.length, "value")} but ${fn.name} takes ${count(takes)} (${names}). Make each entry an array like ${exampleEntry(fn)}${bare}.`
      );
    }
    sets.push(entry);
  }
  return sets;
}

/**
 * The one argument set sent to every contract in an address list. A function
 * without inputs ignores it: the editor shows no inputs to clear a stale value.
 */
export function sharedArgsForList(raw: unknown, fn: ListFunction): unknown[] {
  const takes = fn.inputs.length;
  if (takes === 0) {
    return [];
  }
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") {
      parsed = [];
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `${SHARED_ARGS_LABEL} is not a JSON array. Fill in the arguments for ${fn.name} (${inputNames(fn)}).`
        );
      }
    }
  }
  if (parsed === undefined || parsed === null) {
    parsed = [];
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${SHARED_ARGS_LABEL} must be an array, got ${describeKind(parsed)}. Fill in the arguments for ${fn.name} (${inputNames(fn)}).`
    );
  }
  // The editor stores unfilled trailing inputs as "", as read-contract does.
  let end = parsed.length;
  while (end > 0 && parsed[end - 1] === "") {
    end -= 1;
  }
  const args = parsed.slice(0, end);
  if (args.length !== takes) {
    throw new Error(
      `${SHARED_ARGS_LABEL} has ${plural(args.length, "value")} but ${fn.name} takes ${count(takes)} (${inputNames(fn)}). Fill in every argument; the same ones go to every contract in the list.`
    );
  }
  return args;
}
