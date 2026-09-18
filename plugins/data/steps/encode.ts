import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";

const PLUGIN_NAME = "data";
const ACTION_NAME = "encode";

const HEX_PREFIX = "0x";
const HEX_PATTERN = /^(0x)?[0-9a-fA-F]*$/;
const NON_EMPTY_HEX_PATTERN = /^(0x)?[0-9a-fA-F]+$/;
const DECIMAL_PATTERN = /^[0-9]+$/;
const TRAILING_ZERO_BYTES = /(00)+$/;
const LEADING_ZERO_BYTES = /^(00)+/;

const FIXED_BYTE_SIZES: Record<string, number> = {
  bytes8: 8,
  bytes16: 16,
  bytes32: 32,
};

// Number formats name the Solidity integer type they produce; the value is the
// text format that shares its byte width, so one padding helper serves both.
const NUMBER_FORMATS = {
  hex: "hex",
  uint256: "bytes32",
  uint128: "bytes16",
  uint64: "bytes8",
} as const satisfies Record<string, Format>;

const OPERATIONS = [
  "encode",
  "decode",
  "decimal-to-hex",
  "hex-to-decimal",
] as const;
const FORMATS = ["bytes32", "bytes16", "bytes8", "hex", "base64"] as const;
const PADDINGS = ["right", "left"] as const;

type Operation = (typeof OPERATIONS)[number];
type Format = (typeof FORMATS)[number];
type NumberFormat = keyof typeof NUMBER_FORMATS;
type Padding = (typeof PADDINGS)[number];

// Prefix of every failure message, so the user sees which conversion refused
// the value rather than a generic "encode/decode".
const OPERATION_LABELS: Record<Operation, string> = {
  encode: "Encode",
  decode: "Decode",
  "decimal-to-hex": "Decimal to hex",
  "hex-to-decimal": "Hex to decimal",
};

// The integer type a fixed width stands for, used when a number overflows it.
const WIDTH_LABELS: Record<string, string> = {
  bytes32: "uint256",
  bytes16: "uint128",
  bytes8: "uint64",
};

const WHOLE_NUMBER_HINT =
  "Decimal to hex accepts a whole number from 0 upwards.";

export type EncodeCoreInput = {
  operation?: string;
  format?: string;
  numberFormat?: string;
  padding?: string;
  value: string;
};

export type EncodeInput = StepInput & EncodeCoreInput;

type EncodeResult =
  | {
      success: true;
      result: string | string[];
      map: Record<string, string>;
      count: number;
      operation: Operation;
      format?: Format | NumberFormat;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): EncodeResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function resolveOperation(raw: string | undefined): Operation {
  const candidate = raw as Operation;
  return OPERATIONS.includes(candidate) ? candidate : "encode";
}

function resolveFormat(raw: string | undefined): Format {
  const candidate = (raw ?? "bytes32") as Format;
  return FORMATS.includes(candidate) ? candidate : "bytes32";
}

/**
 * The numeric operations carry their own format field so the dropdown can
 * offer integer widths rather than bytesN and base64. Hex to decimal has no
 * format of its own: leading zeros do not change a number.
 */
function resolveNumberFormat(raw: string | undefined): NumberFormat {
  return raw !== undefined && Object.hasOwn(NUMBER_FORMATS, raw)
    ? (raw as NumberFormat)
    : "hex";
}

/**
 * The format a run reports is the one the user chose. Decimal to hex reports
 * its number format rather than the byte width behind it, and hex to decimal
 * reports none, because no format took part.
 */
function reportedFormat(
  operation: Operation,
  format: Format,
  numberFormat: NumberFormat
): Format | NumberFormat | undefined {
  if (operation === "decimal-to-hex") {
    return numberFormat;
  }
  if (operation === "hex-to-decimal") {
    return undefined;
  }
  return format;
}

function resolvePadding(raw: string | undefined): Padding {
  return raw === "left" ? "left" : "right";
}

/**
 * Accept either a single value or a JSON array of values. A bare string that
 * happens to look like JSON (`["A","B"]`) is treated as the array it is.
 */
function parseInputValues(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("Value is required.");
  }
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("Value must be a string or a JSON array of strings.");
    }
    return parsed.map((item) => String(item));
  }
  return [trimmed];
}

function toHex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function padHex(hex: string, byteSize: number, padding: Padding): string {
  const width = byteSize * 2;
  if (hex.length > width) {
    throw new Error(
      `Value is ${hex.length / 2} bytes, which does not fit in ${byteSize} bytes.`
    );
  }
  return padding === "left" ? hex.padStart(width, "0") : hex.padEnd(width, "0");
}

function encodeValue(value: string, format: Format, padding: Padding): string {
  if (format === "base64") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  const hex = toHex(value);
  const byteSize = FIXED_BYTE_SIZES[format];
  if (byteSize === undefined) {
    return HEX_PREFIX + hex;
  }
  return HEX_PREFIX + padHex(hex, byteSize, padding);
}

function stripHexPadding(hex: string, padding: Padding): string {
  return padding === "left"
    ? hex.replace(LEADING_ZERO_BYTES, "")
    : hex.replace(TRAILING_ZERO_BYTES, "");
}

function decodeValue(value: string, format: Format, padding: Padding): string {
  if (format === "base64") {
    return Buffer.from(value, "base64").toString("utf8");
  }
  if (!HEX_PATTERN.test(value)) {
    throw new Error(`"${value}" is not a hex string.`);
  }
  const raw = value.startsWith(HEX_PREFIX) ? value.slice(2) : value;
  const even = raw.length % 2 === 0 ? raw : `0${raw}`;
  return Buffer.from(stripHexPadding(even, padding), "hex").toString("utf8");
}

/**
 * A number is always padded on the left: zero bytes on the right would
 * multiply it. BigInt keeps a uint256 exact where Number would round.
 *
 * Each refusal names what was wrong with the value and what is accepted, in
 * the words the user typed (a decimal, a width) rather than byte counts.
 */
function decimalToHex(value: string, format: Format): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    throw new Error(`"${value}" is negative. ${WHOLE_NUMBER_HINT}`);
  }
  if (trimmed.includes(".") || trimmed.includes(",")) {
    throw new Error(`"${value}" is not a whole number. ${WHOLE_NUMBER_HINT}`);
  }
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`"${value}" is not a decimal number. ${WHOLE_NUMBER_HINT}`);
  }
  const number = BigInt(trimmed);
  const byteSize = FIXED_BYTE_SIZES[format];
  if (byteSize === undefined) {
    return HEX_PREFIX + number.toString(16);
  }
  const max = BigInt(HEX_PREFIX + "ff".repeat(byteSize));
  if (number > max) {
    throw new Error(
      `${trimmed} does not fit in ${WIDTH_LABELS[format]}: the maximum is ${max}.`
    );
  }
  return HEX_PREFIX + number.toString(16).padStart(byteSize * 2, "0");
}

function hexToDecimal(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    throw new Error(
      `"${value}" is negative. Hex to decimal accepts an unsigned hex value, with or without 0x.`
    );
  }
  if (!NON_EMPTY_HEX_PATTERN.test(trimmed)) {
    throw new Error(`"${value}" is not a hex string.`);
  }
  const raw = trimmed.startsWith(HEX_PREFIX) ? trimmed.slice(2) : trimmed;
  return BigInt(HEX_PREFIX + raw).toString(10);
}

function convertValue(
  value: string,
  operation: Operation,
  format: Format,
  padding: Padding
): string {
  switch (operation) {
    case "encode":
      return encodeValue(value, format, padding);
    case "decode":
      return decodeValue(value, format, padding);
    case "decimal-to-hex":
      return decimalToHex(value, format);
    case "hex-to-decimal":
      return hexToDecimal(value);
  }
}

function stepHandler(input: EncodeCoreInput): EncodeResult {
  const operation = resolveOperation(input.operation);
  try {
    const numberFormat = resolveNumberFormat(input.numberFormat);
    const format =
      operation === "decimal-to-hex"
        ? NUMBER_FORMATS[numberFormat]
        : resolveFormat(input.format);
    const padding = resolvePadding(input.padding);
    const values = parseInputValues(input.value ?? "");

    const map: Record<string, string> = {};
    const converted: string[] = [];
    for (const value of values) {
      const output = convertValue(value, operation, format, padding);
      map[value] = output;
      converted.push(output);
    }

    const reported = reportedFormat(operation, format, numberFormat);
    return {
      success: true,
      result: converted.length === 1 ? converted[0] : converted,
      map,
      count: converted.length,
      operation,
      ...(reported === undefined ? {} : { format: reported }),
    };
  } catch (error) {
    return failed(
      `${OPERATION_LABELS[operation]} failed: ${getErrorMessage(error)}`
    );
  }
}

export async function encodeStep(input: EncodeInput): Promise<EncodeResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

encodeStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
