import { ethers } from "ethers";
import type { AbiParam } from "@/lib/abi/types";
import { type AbiItem, resolveAbiFunction } from "@/lib/abi/utils";

export const MAX_TOTAL_CALLS = 5000;
const MAX_LIST_TEXT_BYTES = 1_048_576;
const MAX_RUN_CALLDATA_BYTES = 10 * 1_048_576;
// Encoding time grows faster than size, so one call and one run are bounded.
const MAX_CALL_CALLDATA_BYTES = 64 * 1024;
const MAX_RUN_VALUES = 50_000;

const CALLS_FROM_ROWS = "rows";
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
// A uint256 has at most 78 digits; longer text is refused before encoding.
const MAX_INTEGER_TEXT = 80;
const ARRAY_TYPE_RE = /^(.*)\[(\d*)\]$/;
const BYTES_N_RE = /^bytes(\d+)$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ETHERS_DETAIL_RE = /\s*\([^()]*\bcode=[A-Z_]+[^()]*\)/g;
const ETHERS_ARGUMENT_RE = /argument="([^"]+)"/;
const NUMBER_FAULT_RE =
  /overflow|underflow|out-of-bounds|BigNumberish|Cannot convert|NUMERIC_FAULT/i;
const LIST_SIZE_STEP =
  "Filter the list first or split it across two Batch Read nodes.";

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
    `Calls From must be "${CALLS_FROM_ROWS}", "${CALLS_FROM_ARGS_LIST}" or "${CALLS_FROM_ADDRESS_LIST}", got ${echo(typeof value === "string" ? `"${value}"` : (JSON.stringify(value) ?? String(value)))}.`
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
    throw new Error(
      `Function '${echo(key)}' is not in the ABI. Pick it again in Function, or check the ABI.`
    );
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
  const singleValue = `${label} got a single value, not a list. If it comes from Encode / Decode, a one-entry array comes back as a plain value; see the docs.`;
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (text === "") {
      throw new Error(
        `${label} is empty or missing. Check the reference and the node that produces it.`
      );
    }
    checkTextSize(text, label, LIST_SIZE_STEP);
    try {
      parsed = JSON.parse(text);
    } catch {
      const looksLikeList = text.startsWith("[") || text.includes(",");
      throw new Error(
        looksLikeList
          ? `${label} is not a JSON array. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like ${typedExample}.`
          : singleValue
      );
    }
  } else if (Array.isArray(parsed)) {
    checkTextSize(parsed, label, LIST_SIZE_STEP);
  }
  if (
    typeof parsed === "string" ||
    typeof parsed === "number" ||
    typeof parsed === "boolean"
  ) {
    throw new Error(singleValue);
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
      `${label} has ${count(parsed.length)} entries; the limit is ${count(MAX_TOTAL_CALLS)} calls per run. ${LIST_SIZE_STEP}`
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

function exampleValue(type: string, components?: AbiParam[]): string {
  if (type.endsWith("]")) {
    return "[...]";
  }
  if (type === "tuple") {
    if (!components?.length) {
      return "{...}";
    }
    const members = components.map((c) => exampleValue(c.type, c.components));
    // Unnamed members can only be given in order.
    if (components.some((c) => !c.name)) {
      return `[${members.join(", ")}]`;
    }
    return `{${components.map((c, i) => `"${c.name}": ${members[i]}`).join(", ")}}`;
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
  return `[${fn.inputs.map((input) => exampleValue(input.type, input.components)).join(", ")}]`;
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

function showValue(value: unknown): string {
  return echo(JSON.stringify(value) ?? String(value));
}

function tupleNames(components: AbiParam[]): string {
  return components.map((c) => c.name || c.type).join(", ");
}

/** Nested array or tuple text, as the editor stores it, parsed once. */
function parseNestedText(value: unknown, nested: boolean): unknown {
  if (!nested || typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!(text.startsWith("[") || text.startsWith("{"))) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/**
 * Give an argument its ABI shape: an array type must be an array, a tuple an
 * array or object. Text is parsed only below the top level, where the editor
 * stores inner arrays as text; the caller estimates the shaped result. A
 * positional tuple becomes an object when every component is named, and
 * stays an array otherwise (ethers takes both; unnamed members would collide).
 */
function structureTuples(
  raw: unknown,
  type: string,
  components: AbiParam[] | undefined,
  path: string,
  nested = false
): unknown {
  const array = ARRAY_TYPE_RE.exec(type);
  const isTuple = type === "tuple" && Boolean(components?.length);
  const value = array || isTuple ? parseNestedText(raw, nested) : raw;
  let got = describeKind(value);
  if (typeof value === "string") {
    got = nested
      ? "text that is not a JSON array"
      : "text. Give the value as a JSON array, not as text holding one";
  }
  if (array) {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array for ${type}, got ${got}.`);
    }
    return value.map((item, index) =>
      structureTuples(item, array[1], components, `${path}[${index}]`, true)
    );
  }
  if (!(isTuple && components)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length !== components.length) {
      throw new Error(
        `${path} has ${plural(value.length, "value")} but its tuple takes ${count(components.length)} (${tupleNames(components)}). Give one value per member, in order.`
      );
    }
    const members = components.map((component, index) =>
      structureTuples(
        value[index],
        component.type,
        component.components,
        `${path}.${component.name || index}`,
        true
      )
    );
    if (components.some((component) => !component.name)) {
      return members;
    }
    const out: Record<string, unknown> = {};
    for (const [index, component] of components.entries()) {
      out[component.name] = members[index];
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    if (components.some((component) => !component.name)) {
      throw new Error(
        `${path} takes its values in order for its tuple (${tupleNames(components)}); give an array.`
      );
    }
    const out: Record<string, unknown> = { ...(value as object) };
    for (const component of components) {
      out[component.name] = structureTuples(
        out[component.name],
        component.type,
        component.components,
        `${path}.${component.name}`,
        true
      );
    }
    return out;
  }
  throw new Error(
    `${path} must be an array or object for its tuple (${tupleNames(components)}), got ${got}.`
  );
}

function checkAddress(value: unknown, path: string): string {
  const address = typeof value === "string" ? value.trim() : "";
  if (!HEX_ADDRESS_RE.test(address)) {
    throw new Error(
      `${path} must be a 0x address with 40 hex characters, got ${showValue(value)}.`
    );
  }
  if (!ethers.isAddress(address)) {
    throw new Error(
      `${path} has a bad checksum: "${address}". Use the address exactly as published, or in all lower case.`
    );
  }
  return address;
}

function checkBool(value: unknown, path: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "true" || text === "false") {
    return text === "true";
  }
  throw new Error(`${path} must be true or false, got ${showValue(value)}.`);
}

function checkBytesN(
  value: unknown,
  type: string,
  size: number,
  path: string
): void {
  if (
    typeof value !== "string" ||
    !HEX_RE.test(value) ||
    value.length !== 2 + size * 2
  ) {
    throw new Error(
      `${path} must be 0x hex for ${type}, got ${showValue(value)}. Turn text into ${type} with the Encode / Decode node first.`
    );
  }
}

function checkLeaf(value: unknown, type: string, path: string): unknown {
  if (value === undefined || value === null) {
    throw new Error(`${path} is missing (${type}).`);
  }
  if (value === "" && type !== "string") {
    const hint = type.startsWith("bytes") ? ' Use "0x" for empty bytes.' : "";
    throw new Error(`${path} cannot be empty (${type}).${hint}`);
  }
  if (type === "bool") {
    return checkBool(value, path);
  }
  if (type === "address") {
    return checkAddress(value, path);
  }
  if (
    INTEGER_TYPE_RE.test(type) &&
    typeof value === "string" &&
    value.trim().length > MAX_INTEGER_TEXT
  ) {
    throw new Error(`${path} is too long for a whole number.`);
  }
  const bytes = BYTES_N_RE.exec(type);
  if (bytes) {
    checkBytesN(value, type, Number(bytes[1]), path);
  }
  return value;
}

/**
 * Leaf checks ahead of encoding, on the shaped argument: a bool must be true
 * or false, an address a 0x address, a bytesN 0x hex of its length.
 */
function checkLeaves(
  value: unknown,
  type: string,
  components: AbiParam[] | undefined,
  path: string
): unknown {
  const array = ARRAY_TYPE_RE.exec(type);
  if (array) {
    return (value as unknown[]).map((item, index) =>
      checkLeaves(item, array[1], components, `${path}[${index}]`)
    );
  }
  if (type !== "tuple" || !components?.length) {
    return checkLeaf(value, type, path);
  }
  if (Array.isArray(value)) {
    return components.map((component, index) =>
      checkLeaves(
        value[index],
        component.type,
        component.components,
        `${path}.${component.name || index}`
      )
    );
  }
  const out: Record<string, unknown> = { ...(value as object) };
  for (const component of components) {
    out[component.name] = checkLeaves(
      out[component.name],
      component.type,
      component.components,
      `${path}.${component.name}`
    );
  }
  return out;
}

/** Shape and check one argument set the way read-contract does; a bool must be true or false. */
function prepareArgs(
  args: unknown[],
  fn: ListFunction,
  where: string
): { args: unknown[]; bytes: number; values: number } {
  try {
    const shaped = fn.inputs.map((input, index) =>
      structureTuples(
        args[index],
        input.type,
        input.components,
        input.name || `arg${index}`
      )
    );
    // Estimated again on the shaped value, so parsed inner text is counted.
    const estimate = estimateCalldata(shaped, fn);
    checkCallSize(estimate.bytes, where);
    const checked = fn.inputs.map((input, index) =>
      checkLeaves(
        shaped[index],
        input.type,
        input.components,
        input.name || `arg${index}`
      )
    );
    return { args: checked, ...estimate };
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(
      message.startsWith(where) ? message : `${where}: ${message}`
    );
  }
}

/** Bytes a dynamic value takes once encoded: its length word plus its padded data. */
function dynamicBytes(value: unknown): number {
  const text = typeof value === "string" ? value : "";
  const length = HEX_RE.test(text)
    ? Math.ceil((text.length - 2) / 2)
    : Buffer.byteLength(text, "utf8");
  return 32 + Math.ceil(length / 32) * 32;
}

/**
 * An upper estimate of the encoded size of one value, 32 bytes per leaf and
 * per dynamic head or length word, computed without encoding anything.
 */
function estimateValue(
  value: unknown,
  type: string,
  components: AbiParam[] | undefined,
  tally: { values: number }
): number {
  tally.values += 1;
  const array = ARRAY_TYPE_RE.exec(type);
  if (array) {
    const items = Array.isArray(value) ? value : [];
    const head = isDynamicType(array[1], components) ? 32 : 0;
    let total = 64;
    for (const item of items) {
      total += head + estimateValue(item, array[1], components, tally);
    }
    return total;
  }
  if (type === "tuple") {
    let total = 32;
    for (const [index, component] of (components ?? []).entries()) {
      const member = Array.isArray(value)
        ? value[index]
        : (value as Record<string, unknown> | undefined)?.[component.name];
      total += estimateValue(
        member,
        component.type,
        component.components,
        tally
      );
    }
    return total;
  }
  if (type === "string" || type === "bytes") {
    return 32 + dynamicBytes(value);
  }
  return 32;
}

function isDynamicType(
  type: string,
  components: AbiParam[] | undefined
): boolean {
  if (type === "string" || type === "bytes" || type.endsWith("[]")) {
    return true;
  }
  const array = ARRAY_TYPE_RE.exec(type);
  if (array) {
    return isDynamicType(array[1], components);
  }
  return (
    type === "tuple" &&
    (components ?? []).some((c) => isDynamicType(c.type, c.components))
  );
}

/** Estimated call data of one call, and how many values it holds. */
function estimateCalldata(
  args: unknown[],
  fn: ListFunction
): { bytes: number; values: number } {
  const tally = { values: 0 };
  let bytes = 4;
  for (const [index, input] of fn.inputs.entries()) {
    bytes += estimateValue(args[index], input.type, input.components, tally);
  }
  return { bytes, values: tally.values };
}

/** One call's estimated call data, checked before it is shaped or encoded. */
function checkCallSize(bytes: number, where: string): void {
  if (bytes > MAX_CALL_CALLDATA_BYTES) {
    throw new Error(
      `${where} is about ${count(Math.ceil(bytes / 1024))} KB of call data; the limit is 64 KB per call. Use smaller arguments.`
    );
  }
}

function checkRunValues(values: number): void {
  if (values > MAX_RUN_VALUES) {
    throw new Error(
      `The calls add up to ${count(values)} values; the limit is ${count(MAX_RUN_VALUES)} per run. Use fewer or smaller entries.`
    );
  }
}

/** An encoder error without ethers' detail suffix, in words for numbers. */
export function encodeReason(error: unknown, fn: ListFunction): string {
  const message = error instanceof Error ? error.message : String(error);
  const reported = ETHERS_ARGUMENT_RE.exec(message)?.[1];
  const names = fn.inputs.map((input) => input.name);
  let name: string | undefined;
  if (reported && names.includes(reported)) {
    name = reported;
  } else if (names.length === 1) {
    name = names[0];
  }
  if (NUMBER_FAULT_RE.test(message)) {
    return `${name ? `${name} ` : "it "}must be a whole number; write large numbers in quotes, e.g. "12345678901234567890".`;
  }
  const reason = echo(message.replace(ETHERS_DETAIL_RE, ""), MAX_REASON_LENGTH);
  const prefix = name ? `${name}: ` : "";
  return `${prefix}${reason}${reason.endsWith(".") ? "" : "."}`;
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
      `${at} must be an array of ${plural(takes, "value")} for ${fn.name} (${names}), got ${describeKind(entry)}. Make each entry an array like ${exampleEntry(fn)}.`
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
  let bytes = 0;
  let values = 0;
  return entries.map((entry, index) => {
    const at = `${ARGS_LIST_LABEL} entry ${index + 1}`;
    const raw = entryToArgs(entry, fn, at);
    // Bounded before shaping, and again on the shaped value (inner text parsed).
    const rough = estimateCalldata(raw, fn);
    checkCallSize(rough.bytes, at);
    checkRunValues(values + rough.values);
    checkRunCalldata(bytes + rough.bytes, "entries");
    const prepared = prepareArgs(raw, fn, at);
    bytes += prepared.bytes;
    values += prepared.values;
    checkRunValues(values);
    checkRunCalldata(bytes, "entries");
    return prepared.args;
  });
}

/**
 * The one argument set sent to every contract in an address list. A function
 * without inputs ignores it: the editor shows no inputs to clear a stale value.
 */
export function sharedArgsForList(
  raw: unknown,
  fn: ListFunction,
  copies: number
): unknown[] {
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
  // Encoded once and reused, so its values count once.
  const rough = estimateCalldata(args, fn);
  checkCallSize(rough.bytes, SHARED_ARGS_LABEL);
  checkRunValues(rough.values);
  checkRunCalldata(rough.bytes * copies, "addresses");
  const prepared = prepareArgs(args, fn, SHARED_ARGS_LABEL);
  checkRunValues(prepared.values);
  checkRunCalldata(prepared.bytes * copies, "addresses");
  return prepared.args;
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
