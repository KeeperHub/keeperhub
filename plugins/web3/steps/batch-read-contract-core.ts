import { ethers } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import type { AbiParam } from "@/lib/abi/types";
import { type AbiItem, resolveAbiFunction } from "@/lib/abi/utils";
import { validateArgsForAbi } from "@/lib/abi/validate-args";

export const MAX_TOTAL_CALLS = 5000;
export const MAX_LIST_TEXT_BYTES = 1_048_576;
export const MAX_RUN_CALLDATA_BYTES = 10 * 1_048_576;

export const CALLS_FROM_ROWS = "rows";
export const CALLS_FROM_ARGS_LIST = "args-list";
export const CALLS_FROM_ADDRESS_LIST = "address-list";

export const ARGS_LIST_LABEL = "Argument Sets";
export const ADDRESS_LIST_LABEL = "Contract Addresses";
export const SHARED_ARGS_LABEL = "Function Arguments";

const MAX_ECHOED_LENGTH = 60;
export const MAX_REASON_LENGTH = 200;
const EN_US = "en-US";
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SCALAR_TYPE_RE = /^(address|bool|string|bytes\d*|u?int\d*)$/;
const INTEGER_TYPE_RE = /^u?int\d*$/;
const ARRAY_TYPE_RE = /^(.*)\[\d*\]$/;

export type ListFunction = {
  name: string;
  // Canonical signature, so an overloaded function encodes the one picked.
  signature: string;
  inputs: AbiParam[];
  outputs?: { name?: string; type: string }[];
};

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
    `Calls From must be "${CALLS_FROM_ROWS}", "${CALLS_FROM_ARGS_LIST}" or "${CALLS_FROM_ADDRESS_LIST}", got "${echo(String(value))}".`
  );
}

export function echo(text: string, max = MAX_ECHOED_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
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

// Rounded up, so a value just over a limit never reads as the limit itself.
function megabytes(bytes: number): string {
  return (Math.ceil((bytes / 1_048_576) * 10) / 10).toFixed(1);
}

function textBytes(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text ?? "", "utf8");
}

function checkTextSize(value: unknown, label: string, nextStep: string): void {
  const bytes = textBytes(value);
  if (bytes > MAX_LIST_TEXT_BYTES) {
    throw new Error(
      `${label} is ${megabytes(bytes)} MB; the limit is 1 MB. ${nextStep}`
    );
  }
}

/** Resolve the picked function, a bare name or a full signature for an overload. */
export function resolveListFunction(
  parsedAbi: unknown[],
  key: string
): ListFunction {
  const resolution = resolveAbiFunction(parsedAbi as AbiItem[], key);
  if (resolution.status === "ambiguous") {
    throw new Error(
      `Function '${echo(key)}' matches more than one function in the ABI. Pick the one you mean in Function.`
    );
  }
  if (resolution.status === "not_found") {
    throw new Error(`Function '${echo(key)}' not found in ABI`);
  }
  return {
    name: resolution.entry.name,
    signature: resolution.canonicalKey,
    inputs: (resolution.entry.inputs ?? []) as AbiParam[],
    outputs: resolution.entry.outputs,
  };
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
  let parsed: unknown = raw ?? "";
  const sizeStep =
    "Filter the list first or split it across two Batch Read nodes.";
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (text === "") {
      throw new Error(
        `${label} is required. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like ${typedExample}.`
      );
    }
    checkTextSize(text, label, sizeStep);
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `${label} is not a JSON array. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like ${typedExample}.`
      );
    }
  } else if (Array.isArray(parsed)) {
    checkTextSize(parsed, label, sizeStep);
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
        `${at} must be an address string, got ${describeKind(entry)}. Point the list at the addresses themselves, e.g. ["0xabc..."].`
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
  if (type === "tuple") {
    return "{...}";
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

function isPrimitive(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** The first bool, at any depth, that is not a real boolean. */
function findNonBoolean(
  value: unknown,
  type: string,
  components: AbiParam[] | undefined,
  path: string
): { path: string; value: unknown } | undefined {
  const array = ARRAY_TYPE_RE.exec(type);
  if (array) {
    if (!Array.isArray(value)) {
      return;
    }
    for (const [index, item] of value.entries()) {
      const found = findNonBoolean(
        item,
        array[1],
        components,
        `${path}[${index}]`
      );
      if (found) {
        return found;
      }
    }
    return;
  }
  if (type === "tuple") {
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [index, component] of (components ?? []).entries()) {
      const member = Array.isArray(value)
        ? value[index]
        : (value as Record<string, unknown>)[component.name];
      const found = findNonBoolean(
        member,
        component.type,
        component.components,
        `${path}.${component.name || index}`
      );
      if (found) {
        return found;
      }
    }
    return;
  }
  if (type === "bool" && typeof value !== "boolean") {
    return { path, value };
  }
  return;
}

/**
 * Shape and check one argument set the way read-contract does, then refuse
 * any bool that is not true or false so a text like "no" never encodes as true.
 */
export function prepareArgs(
  args: unknown[],
  fn: ListFunction,
  where: string
): unknown[] {
  const entry = { inputs: fn.inputs };
  const coerced = coerceArgsForAbi(reshapeArgsForAbi(args, entry), entry);
  const validation = validateArgsForAbi(coerced, entry);
  if (!validation.ok) {
    throw new Error(`${where}: ${echo(validation.error, MAX_REASON_LENGTH)}.`);
  }
  for (const [index, input] of fn.inputs.entries()) {
    const found = findNonBoolean(
      coerced[index],
      input.type,
      input.components,
      input.name || `arg${index}`
    );
    if (found) {
      throw new Error(
        `${where}: ${found.path} must be true or false, got ${echo(JSON.stringify(found.value) ?? String(found.value))}.`
      );
    }
  }
  return coerced;
}

/** A list of argument sets needs a function that takes some; checked before the list. */
export function requireArguments(fn: ListFunction): void {
  if (fn.inputs.length === 0) {
    throw new Error(
      `${fn.name} takes no arguments, so a list of argument sets has nothing to change between calls. To call it on many contracts, set Calls From to "A list of contract addresses".`
    );
  }
}

function entryToArgs(entry: unknown, fn: ListFunction, at: string): unknown[] {
  const takes = fn.inputs.length;
  const names = inputNames(fn);
  const scalar = takesOneScalar(fn);
  if (!Array.isArray(entry)) {
    if (scalar && isPrimitive(entry)) {
      return [entry];
    }
    if (scalar) {
      throw new Error(
        `${at} must be a value for ${fn.name} (${names}), got ${describeKind(entry)}. Point the list at the values themselves, e.g. {{@node1:Label.result.wallets}}.`
      );
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
  return entry;
}

/**
 * One argument set per entry. An entry is the call's arguments in order; for
 * a function with one plain-typed argument it may also be the bare value.
 */
export function argSetsFromList(
  entries: unknown[],
  fn: ListFunction
): unknown[][] {
  return entries.map((entry, index) => {
    const at = `${ARGS_LIST_LABEL} entry ${index + 1}`;
    return prepareArgs(entryToArgs(entry, fn, at), fn, at);
  });
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
  checkTextSize(raw ?? "", SHARED_ARGS_LABEL, "Use smaller arguments.");
  let parsed: unknown = raw ?? [];
  if (typeof parsed === "string") {
    const text = parsed.trim();
    try {
      parsed = text === "" ? [] : JSON.parse(text);
    } catch {
      throw new Error(
        `${SHARED_ARGS_LABEL} is not a JSON array. Fill in the arguments for ${fn.name} (${inputNames(fn)}).`
      );
    }
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
  return prepareArgs(args, fn, SHARED_ARGS_LABEL);
}

/** Total encoded call data of one run, checked before any RPC call. */
export function checkRunCalldata(totalBytes: number, fewer: string): void {
  if (totalBytes > MAX_RUN_CALLDATA_BYTES) {
    throw new Error(
      `The calls' data adds up to ${megabytes(totalBytes)} MB; the limit is 10 MB per run. Use smaller arguments or fewer ${fewer}.`
    );
  }
}

/** Byte length of 0x-prefixed hex call data. */
export function calldataBytes(callData: string): number {
  return Math.max(0, (callData.length - 2) / 2);
}
