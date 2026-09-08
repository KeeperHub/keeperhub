/**
 * Solidity Type to UI Field Mapping and Validation
 *
 * Maps Solidity types to protocol-specific UI field types and provides
 * advisory validation functions for client-side input checking.
 */

import type { ActionConfigFieldBase } from "@/plugins/registry";

const TEMPLATE_VARIABLE_RE = /^\{\{.+\}\}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_NUMBER_RE = /^\d+(\.\d+)?$/;

export type ValidationResult =
  | { valid: true }
  | { valid: false; message: string };

const VALID: ValidationResult = { valid: true };

function isTemplateVariable(value: string): boolean {
  return TEMPLATE_VARIABLE_RE.test(value.trim());
}

/**
 * Map a Solidity type string to a UI field type for the protocol form builder.
 * Returns "template-input" as fallback for unrecognized types.
 */
export function solidityTypeToFieldType(
  solidityType: string
): ActionConfigFieldBase["type"] {
  if (solidityType === "address") {
    return "protocol-address";
  }
  if (solidityType === "bool") {
    return "protocol-bool";
  }
  if (solidityType.startsWith("uint")) {
    return "protocol-uint";
  }
  if (solidityType.startsWith("int")) {
    return "protocol-int";
  }
  if (solidityType.startsWith("bytes")) {
    return "protocol-bytes";
  }
  if (solidityType === "string") {
    return "template-input";
  }
  return "template-input";
}

/**
 * Advisory validation for a value against its Solidity type.
 * Template variables always pass. Empty strings return invalid (required).
 */
export function validateSolidityValue(
  solidityType: string,
  value: string
): ValidationResult {
  if (value === "") {
    return { valid: false, message: "Required" };
  }

  if (isTemplateVariable(value)) {
    return VALID;
  }

  if (solidityType === "address") {
    return validateAddress(value);
  }

  if (solidityType.startsWith("uint")) {
    const bits = solidityType === "uint" ? 256 : Number(solidityType.slice(4));
    return validateUint(value, bits);
  }

  if (solidityType.startsWith("int")) {
    const bits = solidityType === "int" ? 256 : Number(solidityType.slice(3));
    return validateInt(value, bits);
  }

  if (solidityType === "bool") {
    return validateBool(value);
  }

  if (solidityType.startsWith("bytes")) {
    const length =
      solidityType === "bytes" ? undefined : Number(solidityType.slice(5));
    return validateBytes(value, length);
  }

  return VALID;
}

export function validateAddress(value: string): ValidationResult {
  if (!ADDRESS_RE.test(value)) {
    return {
      valid: false,
      message: "Invalid address (expected 0x + 40 hex characters)",
    };
  }
  return VALID;
}

export function validateUint(value: string, bits = 256): ValidationResult {
  try {
    const n = BigInt(value);
    if (n < BigInt(0)) {
      return { valid: false, message: "Must be non-negative" };
    }
    const max = (BigInt(1) << BigInt(bits)) - BigInt(1);
    if (n > max) {
      return { valid: false, message: `Exceeds uint${bits} max` };
    }
    return VALID;
  } catch {
    return { valid: false, message: "Must be a valid integer" };
  }
}

export function validateInt(value: string, bits = 256): ValidationResult {
  try {
    const n = BigInt(value);
    const half = BigInt(1) << BigInt(bits - 1);
    if (n < -half || n >= half) {
      return { valid: false, message: `Exceeds int${bits} range` };
    }
    return VALID;
  } catch {
    return { valid: false, message: "Must be a valid integer" };
  }
}

export function validateBool(value: string): ValidationResult {
  if (value !== "true" && value !== "false") {
    return { valid: false, message: "Must be true or false" };
  }
  return VALID;
}

export function validateEthValue(value: string): ValidationResult {
  if (TEMPLATE_VARIABLE_RE.test(value.trim())) {
    return VALID;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { valid: false, message: "Required" };
  }
  if (!DECIMAL_NUMBER_RE.test(trimmed)) {
    return { valid: false, message: "Must be a decimal number (e.g. 0.1)" };
  }
  return VALID;
}

export function validateBytes(
  value: string,
  length?: number
): ValidationResult {
  if (!value.startsWith("0x")) {
    return { valid: false, message: "Must be hex (0x-prefixed)" };
  }
  if (!HEX_RE.test(value)) {
    return { valid: false, message: "Invalid hex characters" };
  }
  if (length !== undefined) {
    const byteCount = (value.length - 2) / 2;
    if (byteCount !== length) {
      return {
        valid: false,
        message: `Expected ${length} bytes (${length * 2 + 2} hex chars)`,
      };
    }
  }
  return VALID;
}
