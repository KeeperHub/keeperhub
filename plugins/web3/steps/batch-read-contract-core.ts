import { ethers } from "ethers";
import {
  coerceArgsForAbi,
  parseArrayComponentValue,
  reshapeArgsCounted,
} from "@/lib/abi/struct-args";
import type { AbiParam } from "@/lib/abi/types";
import { type AbiItem, resolveAbiFunction } from "@/lib/abi/utils";
import { validateArgsForAbi } from "@/lib/abi/validate-args";
import { EVM_ADDRESS_RE } from "@/lib/web3/address";
import {
  CALLS_FROM_ADDRESS_LIST,
  CALLS_FROM_ARGS_LIST,
  CALLS_FROM_ROWS,
} from "@/plugins/web3/batch-read-modes";

export const MAX_TOTAL_CALLS = 5000;
const MAX_LIST_TEXT_BYTES = 1_048_576;
const MAX_RUN_CALLDATA_BYTES = 10 * 1_048_576;
// Encoding time grows faster than size, so one call and one run are bounded.
const MAX_CALL_CALLDATA_BYTES = 64 * 1024;
const MAX_RUN_VALUES = 50_000;
// Parameters and tuple members a list's function may declare, nested included.
const MAX_ABI_PARAMS = 1000;

export const ARGS_LIST_LABEL = "Argument Sets";
export const ADDRESS_LIST_LABEL = "Contract Addresses";
export const SHARED_ARGS_LABEL = "Function Arguments";

const MAX_ECHOED_LENGTH = 60;
export const MAX_REASON_LENGTH = 200;
const EN_US = "en-US";
const SCALAR_TYPE_RE = /^(address|bool|string|bytes\d*|u?int\d*)$/;
const INTEGER_TYPE_RE = /^u?int\d*$/;
const INTEGER_PREFIX_RE = /^u?int/;
// The longest integer text that can fit 256 bits: "-0b" and 256 binary digits.
const MAX_INTEGER_TEXT = 260;
const DIGIT_RE = /\d/;
const E_NOTATION_RE = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)e[+-]?\d+\s*$/i;
const ARRAY_TYPE_RE = /^(.*)\[(\d*)\]$/;
const ARRAY_SUFFIXES_RE = /(\[\d*\])+$/;
// Levels an example expands; with at most 3 items shown per array it stays short.
const EXAMPLE_DEPTH = 2;
const BYTES_N_RE = /^bytes(\d+)$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ETHERS_DETAIL_RE = /\s*\([^()]*\bcode=[A-Z_]+[^()]*\)/g;
const ETHERS_ARGUMENT_RE = /argument="([^"]+)"/;
const NUMBER_RANGE_RE = /overflow|underflow|out-of-bounds/i;
// validateArgsForAbi's wording for a blank or absent value.
const BLANK_ERROR_RE = /cannot be empty|is missing$/;
const LIST_SIZE_STEP =
  "Filter the list first or split it across two Batch Read nodes.";

export type ListFunction = {
  name: string;
  // Canonical signature, so an overloaded function encodes the one picked.
  signature: string;
  inputs: AbiParam[];
  outputs?: { name?: string; type: string }[];
};

type CallsFrom =
  | typeof CALLS_FROM_ROWS
  | typeof CALLS_FROM_ARGS_LIST
  | typeof CALLS_FROM_ADDRESS_LIST;

/**
 * A problem with where the calls go (Network, Contract Address or Contract
 * Addresses): the read has nowhere to call, so Fail workflow on error off
 * does not soften it, as in Read Contract.
 */
export class DestinationError extends Error {}

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
    `Calls From must be "${CALLS_FROM_ROWS}", "${CALLS_FROM_ARGS_LIST}" or "${CALLS_FROM_ADDRESS_LIST}", got ${showValue(value)}.`
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

// A list passed as a value may hold a bigint, which JSON.stringify refuses.
function jsonText(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item
  );
}

function showValue(value: unknown): string {
  return echo(jsonText(value) ?? String(value));
}

// Rounded up, so a value just over a limit never reads as the limit itself.
function megabytes(bytes: number): string {
  return (Math.ceil((bytes / 1_048_576) * 10) / 10).toFixed(1);
}

function textBytes(value: unknown): number {
  const text = typeof value === "string" ? value : jsonText(value);
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

/**
 * Why `value` is not an address, or undefined when it is. Accepts what Read
 * Contract and the encoder accept (ethers.isAddress); mixed case must carry a
 * valid checksum. Callers trim first where a template may add spaces.
 */
export function addressError(
  value: unknown,
  label: string
): string | undefined {
  const text = typeof value === "string" ? value : "";
  if (text !== "" && ethers.isAddress(text)) {
    return;
  }
  const hex = text.startsWith("0x") ? text : `0x${text}`;
  if (EVM_ADDRESS_RE.test(hex)) {
    return `${label} has a bad checksum: "${text}". Use the address exactly as published, or in all lower case.`;
  }
  const shown =
    typeof value === "string" ? `"${echo(text)}"` : showValue(value);
  const trimmed = text.trim();
  const spaced =
    text !== trimmed &&
    EVM_ADDRESS_RE.test(trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`)
      ? " Remove the spaces around it."
      : " Use a 0x address with 40 hex characters.";
  return `${label} is not a valid address: ${shown}.${spaced}`;
}

/** Contract Address, trimmed and checked; throws DestinationError otherwise. */
export function contractAddressFrom(value: unknown, label: string): string {
  const address = typeof value === "string" ? value.trim() : value;
  if (address === undefined || address === null || address === "") {
    throw new DestinationError(
      `${label} is required. Enter the contract to call.`
    );
  }
  const error = addressError(address, label);
  if (error) {
    throw new DestinationError(error);
  }
  return address as string;
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
 * For a destination list, a blank field or one that is not a list throws
 * DestinationError; an empty list and the size caps stay ordinary errors.
 */
export function parseListInput(
  raw: unknown,
  label: string,
  typedExample: string,
  destination = false
): unknown[] {
  const Shape = destination ? DestinationError : Error;
  let parsed: unknown = raw ?? "";
  const singleValue = `${label} got a single value, not a list. If it comes from Encode / Decode, a one-entry array comes back as a plain value; see the docs.`;
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (text === "") {
      throw new Shape(
        `${label} is missing: the field is blank or its reference resolved to nothing. Check the reference and the node that produces it.`
      );
    }
    checkTextSize(text, label, LIST_SIZE_STEP);
    try {
      parsed = JSON.parse(text);
    } catch {
      const looksLikeList = text.startsWith("[") || text.includes(",");
      throw new Shape(
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
    throw new Shape(singleValue);
  }
  if (!Array.isArray(parsed)) {
    throw new Shape(
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

/** Every entry must be a contract address; a bad one throws DestinationError. */
export function addressesFromList(entries: unknown[]): string[] {
  const addresses: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const at = `${ADDRESS_LIST_LABEL} entry ${index + 1}`;
    if (typeof entry !== "string") {
      throw new DestinationError(
        `${at} must be an address string, got ${describeKind(entry)}. Point the list at the addresses themselves, e.g. ["0xabc..."].`
      );
    }
    const address = entry.trim();
    const error = addressError(address, at);
    if (error) {
      throw new DestinationError(error);
    }
    addresses.push(address);
  }
  return addresses;
}

function inputNames(fn: ListFunction): string {
  return fn.inputs
    // An unnamed tuple goes by its place, as the tuple messages name it.
    .map(
      (input, index) =>
        input.name ||
        (input.type === "tuple" ? `arg${index}` : input.type) ||
        `arg${index}`
    )
    .join(", ");
}

/** Two levels of an argument's shape; deeper arrays and tuples show as [...] and {...}. */
function exampleValue(
  type: string,
  components?: AbiParam[],
  depth = 0
): string {
  const array = ARRAY_TYPE_RE.exec(type);
  if (array) {
    if (depth >= EXAMPLE_DEPTH) {
      return "[...]";
    }
    const item = exampleValue(array[1], components, depth + 1);
    const size = Number(array[2]);
    return array[2] && size <= 3
      ? `[${new Array<string>(size).fill(item).join(", ")}]`
      : `[${item}, ${item}]`;
  }
  if (type === "tuple") {
    if (
      depth >= EXAMPLE_DEPTH ||
      !components?.length ||
      components.some((c) => !c.name)
    ) {
      return "{...}";
    }
    const members = components.map(
      (c) => `"${c.name}": ${exampleValue(c.type, c.components, depth + 1)}`
    );
    return `{${members.join(", ")}}`;
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
  const example = fn.inputs
    .map((input) => exampleValue(input.type, input.components))
    .join(", ");
  // A very wide tuple would otherwise make a very long message.
  return echo(`[${example}]`, MAX_REASON_LENGTH);
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

function integerBits(type: string): number {
  return Number(type.replace(INTEGER_PREFIX_RE, "")) || 256;
}

// Past the type's limits even after rounding: a typed 2^64 - 1 reads as 2^64,
// which is not past uint64's, so it keeps the quotes advice.
function pastIntegerLimit(value: number, type: string): boolean {
  const bits = integerBits(type);
  if (type.startsWith("uint")) {
    return value < 0 || value > 2 ** bits;
  }
  const limit = 2 ** (bits - 1);
  return value > limit || value < -limit;
}

function tooManyDigits(path: string, value: number, type: string): string {
  if (pastIntegerLimit(value, type)) {
    return outOfRange(`${path} `, type);
  }
  const example = value < 0 ? "-12345678901234567890" : "12345678901234567890";
  return `${path} has too many digits to send as a number and may have lost some. Write it in quotes, like "${example}", or have the earlier node send it as text`;
}

// Read with the encoder's own parse, so text it would refuse is named by path.
// Text with no digit ("  ", "-") is refused too: the encoder reads it as 0.
function integerTextError(value: string, path: string): string | undefined {
  if (value.length > MAX_INTEGER_TEXT) {
    return `${path} is too long for a whole number. Write it in at most 78 digits, with no spaces around it`;
  }
  const refused = `${path} must be a whole number in digits, got ${showValue(value)}`;
  if (!DIGIT_RE.test(value)) {
    return refused;
  }
  try {
    ethers.getBigInt(value);
    return;
  } catch {
    return E_NOTATION_RE.test(value)
      ? `${refused}. Write out all the digits`
      : refused;
  }
}

// A JSON number past 2^53 has already lost digits.
function integerLeafError(
  value: unknown,
  path: string,
  type: string
): string | undefined {
  if (typeof value === "string") {
    return integerTextError(value, path);
  }
  if (typeof value === "bigint") {
    return;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    return `${path} must be a whole number, got ${typeof value === "number" ? "NaN" : showValue(value)}`;
  }
  if (!Number.isFinite(value)) {
    return tooManyDigits(path, value, type);
  }
  if (!Number.isInteger(value)) {
    return `${path} must be a whole number, got ${showValue(value)}`;
  }
  return Number.isSafeInteger(value)
    ? undefined
    : tooManyDigits(path, value, type);
}

/**
 * The checks lib/abi leaves to the encoder, made before encoding so a list
 * entry fails with its own name: a bool must be true or false, an address a
 * 0x address, a bytesN 0x hex of its length, a whole number not too long.
 */
function checkListLeaf(
  value: unknown,
  type: string,
  path: string
): string | undefined {
  if (type === "bool") {
    return typeof value === "boolean"
      ? undefined
      : `${path} must be true or false, got ${showValue(value)}. Use true or false`;
  }
  if (type === "address") {
    return addressError(value, path);
  }
  if (INTEGER_TYPE_RE.test(type)) {
    const error = integerLeafError(value, path, type);
    if (error) {
      return error;
    }
  }
  const bytes = BYTES_N_RE.exec(type);
  if (
    bytes &&
    (typeof value !== "string" ||
      !HEX_RE.test(value) ||
      value.length !== 2 + Number(bytes[1]) * 2)
  ) {
    return `${path} must be 0x hex for ${type}, got ${showValue(value)}. Turn text into ${type} with the Encode / Decode node first`;
  }
  return;
}

function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * Check one reshaped argument set with Read Contract's pipeline. Its size is
 * estimated first, on the reshaped value and with an early stop, so a wide
 * tuple or a long list cannot cost much before a cap trips; then it is
 * coerced and validated. `valuesBefore` is what earlier entries used.
 */
function prepareArgs(
  reshaped: unknown[],
  fn: ListFunction,
  where: string,
  valuesBefore: number,
  nextStep: (error: string) => string
): { args: unknown[]; bytes: number; values: number } {
  const estimate = estimateCalldata(reshaped, fn, where, valuesBefore);
  const shaped = coerceArgsForAbi(reshaped, fn);
  // Validation stops at the first failure, so this tells whose message it is.
  let leafError = false;
  // List values are resolved at run time, so a {{...}} string is plain text.
  const validation = validateArgsForAbi(shaped, fn, {
    resolved: true,
    fixedArrays: true,
    checkLeaf: (value, type, path) => {
      const error = checkListLeaf(value, type, path);
      leafError = error !== undefined;
      return error;
    },
  });
  if (!validation.ok) {
    // The list's own checks name their next step; the shared ones do not.
    const step = leafError ? "" : ` ${nextStep(validation.error)}`;
    throw new Error(`${where}: ${sentence(validation.error)}${step}`);
  }
  return { args: shaped, ...estimate };
}

/** Running totals for one call's estimate, stopped as soon as a cap is passed. */
type Tally = {
  bytes: number;
  values: number;
  where: string;
  maxValues: number;
};

function addToTally(tally: Tally, bytes: number): void {
  tally.bytes += bytes;
  tally.values += 1;
  if (tally.bytes > MAX_CALL_CALLDATA_BYTES) {
    throw new Error(
      `${tally.where} has more than 64 KB of call data, the limit per call. Use smaller arguments.`
    );
  }
  if (tally.values > tally.maxValues) {
    throw new Error(
      `The calls hold more than ${count(MAX_RUN_VALUES)} values, the limit per run. Use fewer entries or smaller arguments.`
    );
  }
}

/** Bytes a dynamic value takes once encoded: its length word plus its padded data. */
function dynamicBytes(value: unknown, type: string): number {
  const text = typeof value === "string" ? value : "";
  const length =
    type === "bytes" && HEX_RE.test(text)
      ? Math.ceil((text.length - 2) / 2)
      : Buffer.byteLength(text, "utf8");
  return 32 + Math.ceil(length / 32) * 32;
}

/**
 * An upper estimate of one value's encoded size, 32 bytes per leaf and per
 * dynamic head or length word, without encoding. Array text is read as the
 * coerce step will read it, so text cannot slip past the estimate.
 */
function estimateValue(
  value: unknown,
  type: string,
  components: AbiParam[] | undefined,
  tally: Tally
): void {
  const array = ARRAY_TYPE_RE.exec(type);
  if (array) {
    addToTally(tally, 64);
    const parsed = parseArrayComponentValue(value);
    const head = isDynamicType(array[1], components) ? 32 : 0;
    for (const item of Array.isArray(parsed) ? parsed : []) {
      if (head > 0) {
        tally.bytes += head;
      }
      estimateValue(item, array[1], components, tally);
    }
    return;
  }
  if (type === "tuple") {
    addToTally(tally, 32);
    const members = value as Record<string, unknown> | undefined;
    for (const component of components ?? []) {
      estimateValue(
        members?.[component.name],
        component.type,
        component.components,
        tally
      );
    }
    return;
  }
  if (type === "string" || type === "bytes") {
    addToTally(tally, 32 + dynamicBytes(value, type));
    return;
  }
  addToTally(tally, 32);
}

// Per tuple's components, so each declared type is walked once, not per item.
const dynamicTuples = new WeakMap<AbiParam[], boolean>();

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
  if (type !== "tuple" || !components) {
    return false;
  }
  let dynamic = dynamicTuples.get(components);
  if (dynamic === undefined) {
    dynamic = components.some((c) => isDynamicType(c.type, c.components));
    dynamicTuples.set(components, dynamic);
  }
  return dynamic;
}

/** Estimated call data of one call, and how many values it holds; throws at a cap. */
function estimateCalldata(
  args: unknown[],
  fn: ListFunction,
  where: string,
  valuesBefore: number
): { bytes: number; values: number } {
  const tally: Tally = {
    bytes: 4,
    values: 0,
    where,
    maxValues: MAX_RUN_VALUES - valuesBefore,
  };
  for (const [index, input] of fn.inputs.entries()) {
    estimateValue(args[index], input.type, input.components, tally);
  }
  return { bytes: tally.bytes, values: tally.values };
}

/** Every parameter or tuple member with this name, by path, with its leaf type. */
function paramsNamed(
  params: AbiParam[] | undefined,
  name: string,
  path: string,
  found: { path: string; type: string }[]
): void {
  for (const param of params ?? []) {
    const at = path ? `${path}.${param.name}` : param.name;
    if (param.name === name) {
      found.push({ path: at, type: param.type.replace(ARRAY_SUFFIXES_RE, "") });
    }
    paramsNamed(param.components, name, at, found);
  }
}

/**
 * The input ethers named. It reports only the leaf name, so a name used once
 * (top level or in a tuple) is named and one used more than once names
 * nothing. With no name (an array item), a function's only input is used.
 */
function reportedParam(
  fn: ListFunction,
  reported: string | undefined
): { path: string; type: string } | undefined {
  const found: { path: string; type: string }[] = [];
  if (reported) {
    paramsNamed(fn.inputs, reported, "", found);
  }
  if (found.length === 1) {
    return found[0];
  }
  const only = fn.inputs.length === 1 ? fn.inputs[0] : undefined;
  return only && found.length === 0
    ? { path: only.name, type: only.type.replace(ARRAY_SUFFIXES_RE, "") }
    : undefined;
}

function outOfRange(subject: string, type: string | undefined): string {
  if (!(type && INTEGER_TYPE_RE.test(type))) {
    return `${subject}is out of range for its type. Check that each number fits its type in the ABI.`;
  }
  const unsigned = type.startsWith("uint");
  const bits = integerBits(type);
  if (bits <= 64) {
    const two = BigInt(2);
    const low = unsigned ? BigInt(0) : -(two ** BigInt(bits - 1));
    const high =
      (unsigned ? two ** BigInt(bits) : two ** BigInt(bits - 1)) - BigInt(1);
    return `${subject}is out of range for ${type}. Use a whole number from ${low} to ${high}.`;
  }
  const limits = unsigned
    ? "cannot be negative and has a maximum"
    : "has a minimum and a maximum";
  return `${subject}is out of range for ${type}, which ${limits}.`;
}

/** An encoder error without ethers' detail suffix, in words for numbers. */
export function encodeReason(error: unknown, fn: ListFunction): string {
  const message = error instanceof Error ? error.message : String(error);
  const reported = ETHERS_ARGUMENT_RE.exec(message)?.[1];
  const found = reportedParam(fn, reported);
  const name = found?.path;
  const subject = name ? `${name} ` : "a value ";
  if (NUMBER_RANGE_RE.test(message)) {
    return outOfRange(subject, found?.type);
  }
  const reason = echo(message.replace(ETHERS_DETAIL_RE, ""), MAX_REASON_LENGTH);
  const prefix = name ? `${name}: ` : "";
  return `${prefix}${reason}${reason.endsWith(".") ? "" : "."}`;
}

/** The first tuple with an unnamed member, by path; tuples go by member name. */
function unnamedTuple(
  params: AbiParam[] | undefined,
  path: string
): string | undefined {
  for (const [index, param] of (params ?? []).entries()) {
    const at = path
      ? `${path}.${param.name || index}`
      : param.name || `arg${index}`;
    if (!param.type.startsWith("tuple")) {
      continue;
    }
    if (param.components?.some((c) => !c.name)) {
      return at;
    }
    const inner = unnamedTuple(param.components, at);
    if (inner) {
      return inner;
    }
  }
  return;
}

/** Every parameter and tuple member in the inputs, nested ones included. */
function paramCount(params: AbiParam[] | undefined): number {
  let total = 0;
  for (const param of params ?? []) {
    total += 1 + paramCount(param.components);
  }
  return total;
}

/**
 * A function the lists can fill: every tuple member named (arguments go by
 * member name, as in Read Contract) and at most MAX_ABI_PARAMS parameters,
 * since shaping, estimating and encoding each walk the declared types.
 */
function checkListFunction(fn: ListFunction): void {
  const at = unnamedTuple(fn.inputs, "");
  if (at) {
    throw new Error(
      `${fn.name} takes a tuple with unnamed members (${at}). Tuple values are given by member name, so Batch Read cannot fill this one.`
    );
  }
  const params = paramCount(fn.inputs);
  if (params > MAX_ABI_PARAMS) {
    throw new Error(
      `${fn.name} declares ${count(params)} parameters and tuple members; a list can call a function with up to ${count(MAX_ABI_PARAMS)}.`
    );
  }
}

/** A list of argument sets needs a function that takes some; checked before the list. */
export function requireArguments(fn: ListFunction): void {
  if (fn.inputs.length === 0) {
    throw new Error(
      `${fn.name} takes no arguments, so a list of argument sets has nothing to change between calls. To call it on many contracts, set Calls From to "A list of contract addresses".`
    );
  }
}

// A tuple whose first member is a tuple can't be given flat: an object in
// its place is read as the whole tuple.
function canGoFlat(input: AbiParam): boolean {
  return (
    input.type === "tuple" &&
    Boolean(input.components?.length) &&
    input.components?.[0].type !== "tuple"
  );
}

type FlatTuple = { label: string; members: number };
type Reading = { flat: FlatTuple[]; end: number };

// A tuple's members, read flat from start, can hold the values there: only a
// member that is a tuple can take an object.
function membersFit(args: unknown[], input: AbiParam, start: number): boolean {
  return (
    canGoFlat(input) &&
    start < args.length &&
    (input.components ?? []).every(
      (member, k) => member.type === "tuple" || !isPlainObject(args[start + k])
    )
  );
}

// The values read with every tuple holding a plain value given flat where its
// members fit. No flat reading is listed when an object lands on a plain input.
function readFlat(args: unknown[], fn: ListFunction): Reading {
  const flat: FlatTuple[] = [];
  let cursor = 0;
  let blocked = false;
  for (const [index, input] of fn.inputs.entries()) {
    const value = args[cursor];
    const members = input.components?.length ?? 0;
    if (input.type !== "tuple" || members === 0) {
      blocked ||= isPlainObject(value);
      cursor += 1;
    } else if (!isPlainObject(value) && membersFit(args, input, cursor)) {
      if (members > 1) {
        flat.push({ label: input.name || `arg${index}`, members });
      }
      cursor += members;
    } else {
      cursor += 1;
    }
  }
  return { flat: blocked ? [] : flat, end: cursor };
}

/** A count message; tuples the values read as flat are named with both counts. */
function countMismatch(
  at: string,
  args: unknown[],
  fn: ListFunction,
  hint: string
): Error {
  const takes = fn.inputs.length;
  const names = inputNames(fn);
  const given = plural(args.length, "value");
  let { flat } = readFlat(args, fn);
  let flatCount = flat.reduce((total, t) => total + t.members - 1, takes);
  // As many values as inputs: a plain count would match, so the first tuple
  // holding a plain value is offered flat, or named when it can't go flat.
  // A one-member tuple given flat already lines up, so it is skipped.
  const index = fn.inputs.findIndex(
    (input, i) =>
      input.type === "tuple" &&
      Boolean(input.components?.length) &&
      !isPlainObject(args[i]) &&
      !(canGoFlat(input) && input.components?.length === 1)
  );
  if (flat.length === 0 && args.length === takes && index !== -1) {
    const input = fn.inputs[index];
    const members = input.components?.length ?? 0;
    if (!canGoFlat(input)) {
      return slotError(at, input, index, args[index]);
    }
    flat = [{ label: input.name || `arg${index}`, members }];
    flatCount = takes + members - 1;
  }
  if (flat.length === 0 || flatCount === args.length) {
    return new Error(
      `${at} has ${given}, but ${fn.name} takes ${count(takes)} (${names}). ${hint}`
    );
  }
  const labels = flat.map((tuple) => tuple.label);
  const listed = echo(
    labels.length > 1
      ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
      : labels[0],
    MAX_REASON_LENGTH
  );
  const shape =
    flat.length === 1
      ? `when ${listed} is an object, or ${count(flatCount)} when ${listed} is given flat as its ${count(flat[0].members)} members`
      : `when ${listed} are objects, or ${count(flatCount)} when they are given flat as their members`;
  return new Error(
    `${at} has ${given} for ${fn.name} (${names}), which takes ${count(takes)} ${shape}. ${hint}`
  );
}

/** A JSON object or array held as text, parsed; undefined for anything else. */
function jsonContainerText(value: unknown): unknown {
  if (typeof value !== "string") {
    return;
  }
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return;
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// True when a value at a tuple's place is the whole tuple in the wrong shape,
// not its first member given flat: the first member decides what it can take.
function isWholeTupleShape(value: unknown, first: AbiParam): boolean {
  const firstIsArray = first.type.endsWith("]");
  if (Array.isArray(value)) {
    return !firstIsArray;
  }
  const parsed = jsonContainerText(value);
  if (parsed === undefined || first.type === "string") {
    return false;
  }
  return Array.isArray(parsed) ? !firstIsArray : true;
}

/**
 * A tuple given as an array of its members or as JSON text. Values are walked
 * the way reshapeArgsCounted takes them, so a tuple given flat moves past all
 * its members; anything else gets the count message.
 */
function positionalTupleError(
  args: unknown[],
  fn: ListFunction,
  at: string
): Error | undefined {
  let cursor = 0;
  for (const [index, input] of fn.inputs.entries()) {
    const value = args[cursor];
    const components = input.type === "tuple" ? input.components : undefined;
    if (!components?.length || isPlainObject(value)) {
      cursor += 1;
      continue;
    }
    if (isWholeTupleShape(value, components[0])) {
      const given = typeof value === "string" ? "text" : "an array";
      return new Error(
        `${at}: give ${input.name || `arg${index}`} as an object with its member names, like ${echo(exampleValue(input.type, components), MAX_REASON_LENGTH)}, not as ${given}.`
      );
    }
    cursor += components.length;
  }
  return;
}

// One tuple holding a plain value is named only when no flat reading of it
// lines up: one with values missing before it, after it, or both.
function tupleSlotError(
  entry: unknown[],
  fn: ListFunction,
  at: string
): Error | undefined {
  if (entry.length !== fn.inputs.length) {
    return;
  }
  const slots = fn.inputs.flatMap((input, index) =>
    input.type === "tuple" &&
    input.components?.length &&
    !isPlainObject(entry[index])
      ? [index]
      : []
  );
  if (slots.length !== 1) {
    return;
  }
  const index = slots[0];
  const input = fn.inputs[index];
  const components = input.components ?? [];
  const members = components.length;
  // Read flat from start, only a tuple member can take an object, and the
  // values after it go to the inputs after it.
  const fits = (start: number): boolean =>
    start >= 0 &&
    start + members <= entry.length &&
    components.every(
      (member, k) => member.type === "tuple" || !isPlainObject(entry[start + k])
    ) &&
    entry
      .slice(start + members)
      .every(
        (value, k) =>
          fn.inputs[index + 1 + k]?.type === "tuple" || !isPlainObject(value)
      );
  const flat = canGoFlat(input);
  if (flat && components.some((_, k) => fits(index - k))) {
    return;
  }
  return slotError(at, input, index, entry[index]);
}

/** A tuple holding a plain value, named; the flat line only where it can go flat. */
function slotError(
  at: string,
  input: AbiParam,
  index: number,
  value: unknown
): Error {
  const members = input.components?.length ?? 0;
  const orFlat = canGoFlat(input)
    ? ` Or give its ${count(members)} members flat in its place.`
    : "";
  return new Error(
    `${at}: ${input.name || `arg${index}`} must be an object with its member names, like ${echo(exampleValue(input.type, input.components), MAX_REASON_LENGTH)}, got ${showValue(value)}.${orFlat}`
  );
}

// A tuple whose first member is a tuple can't be given flat, so one holding
// a plain value is named when some reading lines up (each tuple one value, up
// to every tuple that fits given flat); otherwise the count is given.
function nestedTupleError(
  entry: unknown[],
  fn: ListFunction,
  at: string,
  hint: () => string
): Error | undefined {
  let cursor = 0;
  let found: { input: AbiParam; index: number; value: unknown } | undefined;
  for (const [index, input] of fn.inputs.entries()) {
    const value = entry[cursor];
    const members = input.components?.length ?? 0;
    const plain = input.type === "tuple" && members > 0 && !isPlainObject(value);
    if (plain && membersFit(entry, input, cursor)) {
      cursor += members;
      continue;
    }
    if (plain && !canGoFlat(input) && !found && cursor < entry.length) {
      found = { input, index, value };
    }
    cursor += 1;
  }
  if (!found) {
    return;
  }
  if (entry.length < fn.inputs.length || entry.length > cursor) {
    return countMismatch(at, entry, fn, hint());
  }
  const { input, index, value } = found;
  const components = input.components ?? [];
  if (isWholeTupleShape(value, components[0])) {
    const given = typeof value === "string" ? "text" : "an array";
    const like = echo(exampleValue(input.type, components), MAX_REASON_LENGTH);
    return new Error(
      `${at}: give ${input.name || `arg${index}`} as an object with its member names, like ${like}, not as ${given}.`
    );
  }
  return slotError(at, input, index, value);
}

/** One entry as reshaped arguments, one value per input. */
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
  // Built only when an entry fails: the example walks the whole ABI.
  const hint = (): string =>
    `Make each entry an array like ${exampleEntry(fn)}${scalar ? ", or the bare value" : ""}.`;
  const nested = nestedTupleError(entry, fn, at, hint);
  if (nested) {
    throw nested;
  }
  const reshaped = reshapeArgsCounted(entry, fn);
  if (entry.length !== reshaped.consumed) {
    throw (
      positionalTupleError(entry, fn, at) ??
      tupleSlotError(entry, fn, at) ??
      countMismatch(at, entry, fn, hint())
    );
  }
  return reshaped.args;
}

/**
 * One argument set per entry. An entry is the call's arguments in order; for
 * a function with one plain-typed argument it may also be the bare value.
 */
export function argSetsFromList(
  entries: unknown[],
  fn: ListFunction
): unknown[][] {
  checkListFunction(fn);
  const nextStep = (): string =>
    `An entry for ${fn.name} looks like ${exampleEntry(fn)}.`;
  let bytes = 0;
  let values = 0;
  return entries.map((entry, index) => {
    const at = `${ARGS_LIST_LABEL} entry ${index + 1}`;
    const args = entryToArgs(entry, fn, at);
    const prepared = prepareArgs(args, fn, at, values, nextStep);
    bytes += prepared.bytes;
    values += prepared.values;
    checkRunCalldata(bytes, "entries");
    return prepared.args;
  });
}

/**
 * Function Arguments, reshaped, read as the editor stores it: an input left
 * blank is "" and one never touched may be missing, so trailing blanks are
 * trimmed or padded to the inputs. An empty final `string` is sent as "".
 */
function editorArgs(parsed: unknown[], fn: ListFunction): unknown[] {
  let end = parsed.length;
  while (end > 0 && parsed[end - 1] === "") {
    end -= 1;
  }
  const given = parsed.slice(0, end);
  const reshaped = reshapeArgsCounted(given, fn);
  const { consumed } = reshaped;
  if (given.length !== consumed) {
    const positional = positionalTupleError(given, fn, SHARED_ARGS_LABEL);
    if (positional) {
      throw positional;
    }
  }
  if (given.length > consumed) {
    throw countMismatch(
      SHARED_ARGS_LABEL,
      given,
      fn,
      "The same arguments go to every contract in the list."
    );
  }
  if (given.length === consumed) {
    return reshaped.args;
  }
  const blanks = new Array<string>(consumed - given.length).fill("");
  const padded = [...given, ...blanks];
  return reshapeArgsCounted(padded, fn).args;
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
  if (fn.inputs.length === 0) {
    return [];
  }
  checkListFunction(fn);
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
  // Encoded once and reused, so its values count once.
  const prepared = prepareArgs(
    editorArgs(parsed, fn),
    fn,
    SHARED_ARGS_LABEL,
    0,
    (error) =>
      BLANK_ERROR_RE.test(error)
        ? "Fill in every argument; only a string may be left blank."
        : `Check the arguments for ${fn.name} (${inputNames(fn)}).`
  );
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
