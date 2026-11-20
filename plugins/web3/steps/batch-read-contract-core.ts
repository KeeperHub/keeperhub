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
  badChecksumError,
  count,
  describeKind,
  echo,
  jsonText,
  megabytes,
  notAnAddressError,
  readAddressList,
  readJsonList,
  spacedAddressError,
  textSizeError,
} from "@/plugins/web3/address-list-config";
import {
  CALLS_FROM_ADDRESS_LIST,
  CALLS_FROM_ARGS_LIST,
  CALLS_FROM_ROWS,
} from "@/plugins/web3/batch-read-modes";

export const MAX_TOTAL_CALLS = 5000;
const MAX_RUN_CALLDATA_BYTES = 10 * 1_048_576;
// Encoding time grows faster than size, so one call and one run are bounded.
const MAX_CALL_CALLDATA_BYTES = 64 * 1024;
const MAX_RUN_VALUES = 50_000;
// Parameters and tuple members a list's function may declare, nested included.
const MAX_ABI_PARAMS = 1000;

export const ARGS_LIST_LABEL = "Argument Sets";
export const SHARED_ARGS_LABEL = "Function Arguments";

export const MAX_REASON_LENGTH = 200;
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
const LIST_SIZE_STEP = "Filter the list first or split it across several nodes.";

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

function plural(n: number, word: string): string {
  return `${count(n)} ${word}${n === 1 ? "" : "s"}`;
}

function showValue(value: unknown): string {
  try {
    return echo(jsonText(value) ?? String(value));
  } catch {
    // Nested too deeply for JSON.stringify: named by kind instead.
    return describeKind(value);
  }
}

function looksLikeAddress(text: string): boolean {
  return EVM_ADDRESS_RE.test(text.startsWith("0x") ? text : `0x${text}`);
}

/**
 * Why `value` is not an address, or undefined when it is. Accepts what Read
 * Contract and the encoder accept (ethers.isAddress), so 0x may be left off;
 * mixed case must carry a valid checksum. An address argument is not trimmed.
 */
export function addressError(
  value: unknown,
  label: string
): string | undefined {
  const text = typeof value === "string" ? value : "";
  if (text !== "" && ethers.isAddress(text)) {
    return;
  }
  if (looksLikeAddress(text)) {
    return badChecksumError(label, text);
  }
  if (text !== text.trim() && looksLikeAddress(text.trim())) {
    return spacedAddressError(label, text);
  }
  return notAnAddressError(
    label,
    typeof value === "string" ? `"${echo(text)}"` : showValue(value)
  );
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

/** Argument Sets read into its entries; any failure is an ordinary error. */
export function parseListInput(raw: unknown, fn: ListFunction): unknown[] {
  const list = readJsonList(raw, {
    label: ARGS_LIST_LABEL,
    // A one-entry list for this function.
    example: echo(`[${exampleEntry(fn)}]`, MAX_REASON_LENGTH),
    maxEntries: MAX_TOTAL_CALLS,
    limitUnit: "calls per run",
    nextStep: LIST_SIZE_STEP,
  });
  if (!list.success) {
    throw new Error(list.error);
  }
  return list.entries;
}

/**
 * Contract Addresses read and checked before any call. A failure throws
 * DestinationError, except an empty list, which may be softened.
 */
export function addressesFromList(raw: unknown): string[] {
  const list = readAddressList(raw, ethers.isAddress);
  if (list.success) {
    return list.addresses;
  }
  throw list.emptyList ? new Error(list.error) : new DestinationError(list.error);
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

// An object on a plain value's place is said to belong to a tuple, whichever
// check names it.
function checkListLeaf(
  value: unknown,
  type: string,
  path: string
): string | undefined {
  const error = plainLeafError(value, type, path);
  return error && isPlainObject(value)
    ? `${sentence(error)} Only a tuple takes an object`
    : error;
}

/**
 * The checks lib/abi leaves to the encoder, made before encoding so a list
 * entry fails with its own name: a bool must be true or false, an address a
 * 0x address, a bytesN 0x hex of its length, a whole number not too long.
 */
function plainLeafError(
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
  const validation = validateListArgs(shaped, fn);
  if (validation) {
    // The list's own checks name their next step; the shared ones do not.
    const step = validation.leafError
      ? ""
      : ` ${nextStep(validation.error)}`;
    throw new Error(`${where}: ${sentence(validation.error)}${step}`);
  }
  return { args: shaped, ...estimate };
}

/** The first failure of coerced arguments, or undefined when they are valid. */
function validateListArgs(
  shaped: unknown[],
  fn: ListFunction
): { error: string; leafError: boolean } | undefined {
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
  return validation.ok ? undefined : { error: validation.error, leafError };
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

// A value can sit in an input's or member's place: a tuple takes its object
// or the whole tuple as text or an array, an array an array or JSON array
// text, a string any value but an object or array, and any other type a plain
// value (no object or array, as such or as JSON text).
function fitsPlace(value: unknown, param: AbiParam): boolean {
  if (param.type === "tuple") {
    return isPlainObject(value)
      ? objectFits(value, param)
      : takesOneValue(value, param);
  }
  if (param.type.endsWith("]")) {
    return Array.isArray(value) || containerText(value) === "array";
  }
  if (isPlainObject(value) || Array.isArray(value)) {
    return false;
  }
  return param.type === "string" || containerText(value) === undefined;
}

// A tuple's members, read flat from start, can hold the values there.
function membersFit(args: unknown[], input: AbiParam, start: number): boolean {
  return (
    canGoFlat(input) &&
    start < args.length &&
    // A value missing at the end is left to the count checks.
    (input.components ?? []).every(
      (member, k) =>
        start + k >= args.length || fitsPlace(args[start + k], member)
    )
  );
}

// The values read with every tuple holding a plain value given flat where its
// members fit. Tuples after an object on a plain input are not listed.
function readFlat(args: unknown[], fn: ListFunction): FlatTuple[] {
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
      if (members > 1 && !blocked) {
        flat.push({ label: input.name || `arg${index}`, members });
      }
      cursor += members;
    } else {
      cursor += 1;
    }
  }
  return flat;
}

// The last place an object can go: a tuple's own place or a tuple member's,
// with every tuple before it given flat.
function lastObjectPlace(fn: ListFunction): number {
  let last = -1;
  let start = 0;
  for (const input of fn.inputs) {
    if (input.type.startsWith("tuple")) {
      last = start;
    }
    if (canGoFlat(input)) {
      for (const [k, member] of (input.components ?? []).entries()) {
        if (member.type.startsWith("tuple")) {
          last = start + k;
        }
      }
      start += input.components?.length ?? 1;
    } else {
      start += 1;
    }
  }
  return last;
}

/**
 * An object no tuple can take, named on the plain input it lands on. A missing
 * value plus an extra one could still put it on a tuple; the input is named.
 */
function objectOnPlainInput(
  entry: unknown[],
  fn: ListFunction,
  at: string
): Error | undefined {
  const lastPlace = lastObjectPlace(fn);
  // No tuple input: the count message stays.
  if (lastPlace === -1) {
    return;
  }
  // Each value past the input count may be an extra one before a tuple.
  const last = lastPlace + Math.max(0, entry.length - fn.inputs.length);
  const place = entry.findIndex(
    (value, i) => i > last && isPlainObject(value)
  );
  if (place === -1) {
    return;
  }
  let cursor = 0;
  for (const [index, input] of fn.inputs.entries()) {
    if (cursor > place) {
      return;
    }
    const value = entry[cursor];
    if (cursor === place && !input.type.startsWith("tuple")) {
      return plainInputError(at, input, index, value);
    }
    const plain = input.type === "tuple" && !isPlainObject(value);
    cursor +=
      plain && membersFit(entry, input, cursor)
        ? (input.components?.length ?? 1)
        : 1;
  }
  return;
}

/** A plain input holding an object, named with its own type's wording. */
function plainInputError(
  at: string,
  input: AbiParam,
  index: number,
  value: unknown
): Error {
  const name = input.name || `arg${index}`;
  const error =
    checkListLeaf(value, input.type, name) ??
    `${name} must be a value of type ${input.type}, got ${showValue(value)}. Only a tuple takes an object`;
  return new Error(`${at}: ${sentence(error)}`);
}

// Some choice of tuples given flat makes the inputs take exactly n values.
function countFits(n: number, fn: ListFunction): boolean {
  const extra = n - fn.inputs.length;
  if (extra < 0) {
    return false;
  }
  let sums = new Set([0]);
  for (const input of fn.inputs) {
    const more = canGoFlat(input) ? (input.components?.length ?? 1) - 1 : 0;
    if (more > 0) {
      sums = new Set([...sums, ...[...sums].map((sum) => sum + more)]);
    }
  }
  return sums.has(extra);
}

// The one tuple that can go flat is named; with several, they are not.
function flatTakes(fn: ListFunction): string {
  const flat = fn.inputs.flatMap((input, index) =>
    canGoFlat(input) && (input.components?.length ?? 0) > 1
      ? [{ label: input.name || `arg${index}`, members: input.components?.length ?? 0 }]
      : []
  );
  return flat.length === 1
    ? `the number it takes when ${echo(flat[0].label, MAX_REASON_LENGTH)} is given flat as its ${count(flat[0].members)} members`
    : "a number it takes when tuples are given flat";
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
  let flat = readFlat(args, fn);
  let flatCount = flat.reduce((total, t) => total + t.members - 1, takes);
  // As many values as inputs: a plain count would match, so the first tuple
  // that can go flat and doesn't hold its own object is offered flat. A
  // one-member tuple given flat doesn't change the count, so it is skipped.
  const index =
    flat.length === 0 && args.length === takes
      ? fn.inputs.findIndex(
          (input, i) =>
            canGoFlat(input) &&
            (input.components?.length ?? 0) > 1 &&
            !(isPlainObject(args[i]) && objectFits(args[i], input))
        )
      : -1;
  if (index !== -1) {
    const input = fn.inputs[index];
    const members = input.components?.length ?? 0;
    flat = [{ label: input.name || `arg${index}`, members }];
    flatCount = takes + members - 1;
  }
  // No tuple can change the count, so the count is right.
  if (flat.length === 0 && args.length === takes) {
    return new Error(
      `${at} has ${given} for ${fn.name} (${names}), the right number, but not in the right places. ${hint}`
    );
  }
  // Some tuples given flat take this many values, so the count is not wrong.
  if (
    (flat.length === 0 || flatCount === args.length) &&
    countFits(args.length, fn)
  ) {
    return new Error(
      `${at} has ${given} for ${fn.name} (${names}), ${flatTakes(fn)}, but not in the right places. ${hint}`
    );
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

/**
 * Text that holds a JSON object or array, by its first character for an
 * object ("{", broken or not: never a plain value) and its first and last for
 * an array ("[...]"; "[1" is a bad plain value). Not parsed: line-up checks
 * run it in loops.
 */
function containerText(value: unknown): "object" | "array" | undefined {
  if (typeof value !== "string") {
    return;
  }
  // Read in place, without copying: line-up checks call this in loops.
  let start = 0;
  while (start < value.length && isSpace(value.charCodeAt(start))) {
    start += 1;
  }
  let end = value.length - 1;
  while (end > start && isSpace(value.charCodeAt(end))) {
    end -= 1;
  }
  if (value[start] === "{") {
    return "object";
  }
  return end > start && value[start] === "[" && value[end] === "]"
    ? "array"
    : undefined;
}

// JSON's whitespace: space, tab, line feed, carriage return.
function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

// Text that is not JSON is a member's bad value. An array, as such or as
// text, is the whole tuple only with one fitting item per member; otherwise a
// value before it may be missing.
function readsAsWholeTuple(value: unknown, components: AbiParam[]): boolean {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(parsed)) {
    return true;
  }
  const items: unknown[] = parsed;
  return (
    items.length === components.length &&
    components.every((member, k) => fitsPlace(items[k], member))
  );
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
  const kind = containerText(value);
  if (kind === undefined || first.type === "string") {
    return false;
  }
  return kind === "array" ? !firstIsArray : true;
}

/**
 * A tuple given as an array of its members or as JSON text, named only when
 * the values line up with it given as an object. Values are walked the way
 * reshapeArgsCounted takes them; anything else gets the count message.
 */
function positionalTupleError(
  args: unknown[],
  fn: ListFunction,
  at: string,
  blankTail = false
): Error | undefined {
  let cursor = 0;
  for (const [index, input] of fn.inputs.entries()) {
    const value = args[cursor];
    const components = input.type === "tuple" ? input.components : undefined;
    if (!components?.length || isPlainObject(value)) {
      cursor += 1;
      continue;
    }
    const whole =
      isWholeTupleShape(value, components[0]) &&
      readsAsWholeTuple(value, components);
    if (whole) {
      if (!linesUpFixed(args, fn, cursor, blankTail)) {
        return;
      }
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
// lines up (values missing before it, after it, or both) and the entry lines
// up end to end with it given as an object.
function tupleSlotError(
  entry: unknown[],
  fn: ListFunction,
  at: string,
  blankTail = false
): Error | undefined {
  // With blankTail, inputs missing at the end are blanks, not slots.
  const oneEach = blankTail
    ? entry.length <= fn.inputs.length
    : entry.length === fn.inputs.length;
  const slot = oneEach
    ? slotByIndex(entry, fn)
    : soleTupleSlot(entry, fn, blankTail);
  if (!slot) {
    return;
  }
  const { input, index, place } = slot;
  const components = input.components ?? [];
  const members = components.length;
  // Read flat from start, each member's value fits its place. Values after it
  // are not checked: a value missing there shifts them.
  const fits = (start: number): boolean =>
    start >= 0 &&
    (blankTail || start + members <= entry.length) &&
    components.every(
      (member, k) =>
        start + k >= entry.length || fitsPlace(entry[start + k], member)
    );
  if (canGoFlat(input) && components.some((_, k) => fits(place - k))) {
    return;
  }
  if (!linesUpFixed(entry, fn, place, blankTail)) {
    return;
  }
  return slotError(at, input, index, entry[place]);
}

type TupleSlot = { input: AbiParam; index: number; place: number };

// Longest entry whose places are each tried as the one tuple left plain.
const MAX_SLOT_SEARCH = 64;

// One value per input: the only tuple not holding an object.
function slotByIndex(entry: unknown[], fn: ListFunction): TupleSlot | undefined {
  const slots = fn.inputs.flatMap((input, index) =>
    index < entry.length &&
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
  return { input: fn.inputs[index], index, place: index };
}

// Any other length: the one place that, given an object, lines the entry up,
// when a tuple takes it there. Two such places, at a tuple or inside one,
// are ambiguous.
function soleTupleSlot(
  entry: unknown[],
  fn: ListFunction,
  blankTail: boolean
): TupleSlot | undefined {
  const width = fn.inputs.reduce(
    (total, input) =>
      total + (canGoFlat(input) ? (input.components?.length ?? 1) : 1),
    0
  );
  // No reading of the inputs takes this many values, or too many places to
  // try one by one: the count message is given instead.
  if (entry.length > Math.min(width, MAX_SLOT_SEARCH)) {
    return;
  }
  let found: TupleSlot | undefined;
  let hits = 0;
  for (const [place, value] of entry.entries()) {
    if (isPlainObject(value)) {
      continue;
    }
    const fixed = [...entry];
    fixed[place] = {};
    const starts = lineUpStarts(fixed, fn, blankTail);
    if (!starts) {
      continue;
    }
    if (hits > 0) {
      return;
    }
    hits += 1;
    const index = starts.indexOf(place);
    const input = fn.inputs[index];
    found =
      input?.type === "tuple" && input.components?.length
        ? { input, index, place }
        : undefined;
  }
  return found;
}

/** A tuple holding a plain value, named; the flat line only where it can go flat. */
function slotError(
  at: string,
  input: AbiParam,
  index: number,
  value: unknown
): Error {
  const name = input.name || `arg${index}`;
  // The editor stores an input it has not touched as "".
  const example = echo(
    exampleValue(input.type, input.components),
    MAX_REASON_LENGTH
  );
  if (value === "") {
    const next =
      at === SHARED_ARGS_LABEL
        ? "Fill in every argument; only a string may be left blank."
        : `Give it as an object with its member names, like ${example}.`;
    return new Error(`${at}: ${name} cannot be empty. ${next}`);
  }
  const members = input.components?.length ?? 0;
  const orFlat = canGoFlat(input)
    ? ` Or give its ${count(members)} members flat in its place.`
    : "";
  return new Error(
    `${at}: ${name} must be an object with its member names, like ${example}, got ${showValue(value)}.${orFlat}`
  );
}

// A tuple's place holds one value: an object, or the whole tuple as text or
// an array. A tuple starting with a tuple can't go flat, so any other value
// there does not line up.
function takesOneValue(value: unknown, input: AbiParam): boolean {
  const first = input.components?.[0];
  return (
    isPlainObject(value) ||
    (first !== undefined && isWholeTupleShape(value, first))
  );
}

// Every value has a place: each tuple is an object or its members given flat
// (one value when takesOneValue), no plain input holds an object, and nothing
// is left over. With blankTail, values missing at the end are trimmed blanks.
function linesUp(entry: unknown[], fn: ListFunction, blankTail = false): boolean {
  return lineUpStarts(entry, fn, blankTail) !== undefined;
}

// Where each input starts when the entry lines up, or undefined when it does
// not. With blankTail, inputs or flat members missing at the end are blanks,
// which only a string may be: a blank anywhere else fails anyway.
function lineUpStarts(
  entry: unknown[],
  fn: ListFunction,
  blankTail = false
): number[] | undefined {
  const starts: number[] = [];
  let cursor = 0;
  for (const [index, input] of fn.inputs.entries()) {
    starts.push(cursor);
    if (blankTail && cursor >= entry.length) {
      return fn.inputs.slice(index).every(canBeBlank) ? starts : undefined;
    }
    const value = entry[cursor];
    const components = input.type === "tuple" ? (input.components ?? []) : [];
    const members = components.length;
    if (members > 0 && isPlainObject(value) && !objectFits(value, input)) {
      return;
    }
    if (members > 0 && takesOneValue(value, input)) {
      if (cursor >= entry.length) {
        return;
      }
      cursor += 1;
    } else if (members > 0) {
      const missing = components.slice(entry.length - cursor);
      if (
        !membersFit(entry, input, cursor) ||
        missing.some((member) => member.type !== "string")
      ) {
        return;
      }
      cursor += members;
    } else if (cursor >= entry.length || !fitsPlace(value, input)) {
      return;
    } else {
      cursor += 1;
    }
  }
  const fits = blankTail ? cursor >= entry.length : cursor === entry.length;
  return fits ? starts : undefined;
}

// Only a string, or a flat tuple of strings, may be left blank at the end: a
// blank anywhere else fails.
function canBeBlank(input: AbiParam): boolean {
  return (
    input.type === "string" ||
    (canGoFlat(input) &&
      (input.components ?? []).every((member) => member.type === "string"))
  );
}

// An object can be this tuple's: empty, or sharing a member name with it.
function objectFits(value: unknown, input: AbiParam): boolean {
  const object = value as object;
  if ((input.components ?? []).some((m) => Object.hasOwn(object, m.name))) {
    return true;
  }
  // Empty, checked without listing every key of a large object.
  for (const key in object) {
    if (Object.hasOwn(object, key)) {
      return false;
    }
  }
  return true;
}

// The entry lines up with the value at place given as an object (or, for a
// plain input, as a plain value).
function linesUpFixed(
  entry: unknown[],
  fn: ListFunction,
  place: number,
  blankTail = false,
  value: unknown = {}
): boolean {
  const fixed = [...entry];
  fixed[place] = value;
  return linesUp(fixed, fn, blankTail);
}

// The first plain input holding an object, named only when the entry lines up
// end to end with a plain value in its place, and the object fits no earlier
// tuple holding a plain value (an extra value may have shifted it).
function plainObjectError(
  entry: unknown[],
  fn: ListFunction,
  at: string,
  blankTail = false
): Error | undefined {
  let cursor = 0;
  const holdingPlain: AbiParam[] = [];
  for (const [index, input] of fn.inputs.entries()) {
    if (cursor >= entry.length) {
      return;
    }
    const value = entry[cursor];
    const members = input.type === "tuple" ? (input.components?.length ?? 0) : 0;
    if (members === 0 && isPlainObject(value)) {
      const shifted = holdingPlain.some((tuple) => objectFits(value, tuple));
      return !shifted && linesUpFixed(entry, fn, cursor, blankTail, 0)
        ? plainInputError(at, input, index, value)
        : undefined;
    }
    if (members > 0 && !isPlainObject(value)) {
      holdingPlain.push(input);
    }
    cursor +=
      canGoFlat(input) && !takesOneValue(value, input) ? members : 1;
  }
  return;
}

type NestedSlot = { input: AbiParam; index: number; place: number };

// The first tuple starting with a tuple that holds a plain value, walked the
// way reshapeArgsCounted takes the values.
function nestedSlot(entry: unknown[], fn: ListFunction): NestedSlot | undefined {
  let cursor = 0;
  for (const [index, input] of fn.inputs.entries()) {
    if (cursor >= entry.length) {
      return;
    }
    const members = input.type === "tuple" ? (input.components?.length ?? 0) : 0;
    if (members === 0 || isPlainObject(entry[cursor])) {
      cursor += 1;
    } else if (canGoFlat(input)) {
      cursor += members;
    } else {
      return { input, index, place: cursor };
    }
  }
  return;
}

// A tuple starting with a tuple can't be given flat. One holding a plain value
// is named only when the entry lines up end to end with it given as an object.
function nestedTupleError(
  entry: unknown[],
  fn: ListFunction,
  at: string,
  blankTail = false
): Error | undefined {
  const slot = nestedSlot(entry, fn);
  if (!(slot && linesUpFixed(entry, fn, slot.place, blankTail))) {
    return;
  }
  return slotError(at, slot.input, slot.index, entry[slot.place]);
}

/**
 * The one input an entry's values point at, when the entry lines up end to end
 * with it fixed; the same for Argument Sets and Function Arguments. With
 * blankTail, values missing at the end are blanks.
 */
function namedProblem(
  entry: unknown[],
  fn: ListFunction,
  at: string,
  blankTail = false
): Error | undefined {
  return (
    positionalTupleError(entry, fn, at, blankTail) ??
    nestedTupleError(entry, fn, at, blankTail) ??
    objectOnPlainInput(entry, fn, at) ??
    plainObjectError(entry, fn, at, blankTail) ??
    tupleSlotError(entry, fn, at, blankTail)
  );
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
  const reshaped = reshapeArgsCounted(entry, fn);
  if (entry.length !== reshaped.consumed || nestedSlot(entry, fn)) {
    throw namedProblem(entry, fn, at) ?? countMismatch(at, entry, fn, hint());
  }
  if (misplacedObject(entry, fn)) {
    throw countMismatch(at, entry, fn, hint());
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
 * blank is "" and one never touched at the end is left out, so missing values
 * are padded as blanks. An empty final `string` is sent as "".
 */
function editorArgs(stored: unknown[], fn: ListFunction): unknown[] {
  const asStored = reshapeArgsCounted(stored, fn).consumed;
  // A list that lines up as stored keeps a flat tuple's blank first member.
  const parsed =
    asStored === stored.length && !nestedSlot(stored, fn)
      ? stored
      : blankTuples(stored, fn);
  // Blanks past what the inputs take are dropped; the rest are checked as stored.
  const takes = reshapeArgsCounted(parsed, fn).consumed;
  let end = parsed.length;
  while (end > takes && parsed[end - 1] === "") {
    end -= 1;
  }
  const given = parsed.slice(0, end);
  const reshaped = reshapeArgsCounted(given, fn);
  const { consumed } = reshaped;
  const countError = (): Error =>
    countMismatch(
      SHARED_ARGS_LABEL,
      given,
      fn,
      "The same arguments go to every contract in the list."
    );
  // Named as in Argument Sets, with strings missing at the end allowed.
  const offShape = given.length !== consumed || nestedSlot(given, fn);
  if (offShape) {
    const named = namedProblem(
      given,
      fn,
      SHARED_ARGS_LABEL,
      given.length < consumed
    );
    if (named) {
      throw named;
    }
  }
  if (given.length < consumed) {
    return paddedArgs(given, consumed, fn, countError);
  }
  if (offShape || misplacedObject(given, fn)) {
    throw countError();
  }
  return reshaped.args;
}

// The editor stores a tuple field left untouched as "": read it as the tuple
// with every member blank, not as its first member given flat.
function blankTuples(values: unknown[], fn: ListFunction): unknown[] {
  const out = [...values];
  let cursor = 0;
  for (const input of fn.inputs) {
    const members = input.type === "tuple" ? (input.components?.length ?? 0) : 0;
    if (members > 0 && out[cursor] === "") {
      out[cursor] = blankObject(input);
    }
    cursor += members > 0 && !isPlainObject(out[cursor]) ? members : 1;
  }
  return out;
}

function blankObject(param: AbiParam): Record<string, unknown> {
  return Object.fromEntries(
    (param.components ?? []).map((member) => [
      member.name,
      member.type === "tuple" ? blankObject(member) : "",
    ])
  );
}

/**
 * Too few values: the rest are blanks the editor left out. Padded only when
 * every value given passes with a valid stand-in in each blank, so a failure
 * names a blank, never a value that may have moved; otherwise the count.
 */
function paddedArgs(
  given: unknown[],
  consumed: number,
  fn: ListFunction,
  countError: () => Error
): unknown[] {
  const blanks = new Array<string>(consumed - given.length).fill("");
  const args = reshapeArgsCounted([...given, ...blanks], fn).args;
  // Size caps first, on the values as given, before any dry run.
  estimateCalldata(args, fn, SHARED_ARGS_LABEL, 0);
  // One budget for every stand-in, the call data a single call may carry.
  const budget = { words: MAX_CALL_CALLDATA_BYTES / 32 };
  const standIns = fn.inputs.map((input, index) =>
    withStandIns(args[index], input, budget)
  );
  if (standIns.some((value) => value === NO_FIT)) {
    throw countError();
  }
  const shaped = coerceArgsForAbi(standIns, fn);
  if (validateListArgs(shaped, fn) || !encodes(shaped, fn)) {
    throw countError();
  }
  return args;
}

// Range and length checks happen only when encoding.
function encodes(args: unknown[], fn: ListFunction): boolean {
  try {
    ethers.AbiCoder.defaultAbiCoder().encode(
      fn.inputs.map((input) => ethers.ParamType.from(input)),
      args
    );
    return true;
  } catch {
    return false;
  }
}

const NO_FIT = Symbol("value that cannot sit in its place");

// The value with each blank ("") replaced by a valid stand-in, or NO_FIT when
// a value does not fit its place (validation lets a string take an object or
// an array) or the blanks are too big to stand in for.
function withStandIns(
  value: unknown,
  param: AbiParam,
  budget: { words: number }
): unknown {
  if (value === "") {
    budget.words -= sampleWords(param);
    // NaN or Infinity from an absurd type is too big as well.
    return budget.words >= 0 ? validSample(param) : NO_FIT;
  }
  const array = ARRAY_TYPE_RE.exec(param.type);
  if (array && Array.isArray(value)) {
    const item = { ...param, type: array[1] };
    const items = value.map((entry) => withStandIns(entry, item, budget));
    return items.includes(NO_FIT) ? NO_FIT : items;
  }
  if (param.type === "tuple" && isPlainObject(value)) {
    const object = value as Record<string, unknown>;
    const members = (param.components ?? []).map(
      (member) =>
        [
          member.name,
          withStandIns(
            Object.hasOwn(object, member.name) ? object[member.name] : undefined,
            member,
            budget
          ),
        ] as const
    );
    return members.some(([, member]) => member === NO_FIT)
      ? NO_FIT
      : { ...object, ...Object.fromEntries(members) };
  }
  return !array && param.type !== "tuple" && !fitsPlace(value, param)
    ? NO_FIT
    : value;
}

// 32-byte words a stand-in of this type takes, at least one per element.
function sampleWords(param: AbiParam): number {
  const array = ARRAY_TYPE_RE.exec(param.type);
  if (array) {
    return array[2]
      ? Number(array[2]) *
          Math.max(1, sampleWords({ ...param, type: array[1] }))
      : 1;
  }
  if (param.type === "tuple") {
    return Math.max(
      1,
      (param.components ?? []).reduce(
        (total, member) => total + sampleWords(member),
        0
      )
    );
  }
  return 1;
}

// Whether any tuple was read from its members, and the member each such
// value lands on (plain inputs map to themselves), as reshapeArgsCounted reads.
function flatReading(
  args: unknown[],
  fn: ListFunction
): { params: AbiParam[]; members: boolean[] } {
  const params: AbiParam[] = [];
  const members: boolean[] = [];
  for (const input of fn.inputs) {
    const components = input.type === "tuple" ? (input.components ?? []) : [];
    if (components.length > 0 && !isPlainObject(args[params.length])) {
      params.push(...components);
      members.push(...components.map(() => true));
    } else {
      params.push(input);
      members.push(false);
    }
  }
  return { params, members };
}

// An object no input there can take: on a plain member of a tuple read from
// its members, or in a tuple's place when it fits another tuple instead. A
// value was likely added or left out before it, so no input can be named.
function misplacedObject(args: unknown[], fn: ListFunction): boolean {
  const { params, members } = flatReading(args, fn);
  return params.some((param, k) => {
    const value = args[k];
    if (!isPlainObject(value)) {
      return false;
    }
    if (param.type !== "tuple") {
      return members[k];
    }
    // Another tuple's object, not this one's with names mistyped.
    return (
      !objectFits(value, param) &&
      tuplesOf(fn.inputs).some((tuple) => objectFits(value, tuple))
    );
  });
}

// Every tuple input and tuple member, at any depth.
function tuplesOf(params: AbiParam[]): AbiParam[] {
  return params.flatMap((param) =>
    param.type === "tuple"
      ? [param, ...tuplesOf(param.components ?? [])]
      : []
  );
}

// A value that passes every check for its type, put where a blank is.
function validSample(param: AbiParam): unknown {
  const array = ARRAY_TYPE_RE.exec(param.type);
  if (array) {
    const item = { ...param, type: array[1] };
    return array[2] ? Array.from({ length: Number(array[2]) }, () => validSample(item)) : [];
  }
  if (param.type === "tuple") {
    return Object.fromEntries(
      (param.components ?? []).map((member) => [member.name, validSample(member)])
    );
  }
  const bytes = BYTES_N_RE.exec(param.type);
  if (bytes) {
    return `0x${"00".repeat(Number(bytes[1]))}`;
  }
  const samples: Record<string, unknown> = {
    address: `0x${"0".repeat(40)}`,
    bool: false,
    bytes: "0x",
    string: "",
  };
  return param.type in samples ? samples[param.type] : "0";
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
  const tooBig = textSizeError(raw ?? "", SHARED_ARGS_LABEL, "Use smaller arguments.");
  if (tooBig) {
    throw new Error(tooBig);
  }
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
