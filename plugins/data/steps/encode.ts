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
const TRAILING_ZERO_BYTES = /(00)+$/;
const LEADING_ZERO_BYTES = /^(00)+/;

const FIXED_BYTE_SIZES: Record<string, number> = {
  bytes8: 8,
  bytes16: 16,
  bytes32: 32,
};

const OPERATIONS = ["encode", "decode"] as const;
const FORMATS = ["bytes32", "bytes16", "bytes8", "hex", "base64"] as const;
const PADDINGS = ["right", "left"] as const;

type Operation = (typeof OPERATIONS)[number];
type Format = (typeof FORMATS)[number];
type Padding = (typeof PADDINGS)[number];

export type EncodeCoreInput = {
  operation?: string;
  format?: string;
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
      format: Format;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): EncodeResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function resolveOperation(raw: string | undefined): Operation {
  return raw === "decode" ? "decode" : "encode";
}

function resolveFormat(raw: string | undefined): Format {
  const candidate = (raw ?? "bytes32") as Format;
  return FORMATS.includes(candidate) ? candidate : "bytes32";
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

function stepHandler(input: EncodeCoreInput): EncodeResult {
  try {
    const operation = resolveOperation(input.operation);
    const format = resolveFormat(input.format);
    const padding = resolvePadding(input.padding);
    const values = parseInputValues(input.value ?? "");

    const map: Record<string, string> = {};
    const converted: string[] = [];
    for (const value of values) {
      const output =
        operation === "encode"
          ? encodeValue(value, format, padding)
          : decodeValue(value, format, padding);
      map[value] = output;
      converted.push(output);
    }

    return {
      success: true,
      result: converted.length === 1 ? converted[0] : converted,
      map,
      count: converted.length,
      operation,
      format,
    };
  } catch (error) {
    return failed(`Encode/decode failed: ${getErrorMessage(error)}`);
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
