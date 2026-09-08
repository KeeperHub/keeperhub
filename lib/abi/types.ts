/**
 * Canonical ABI JSON types (subset of the ethers ABI format), shared by the
 * lib/abi helpers and the workflow config UI.
 *
 * `name` stays required: every call site that shares these types indexes
 * objects by parameter name (struct-args builds tuple objects, validate-args
 * reads tuple members), so an optional name would not type-check against the
 * behavior the code relies on.
 */

export type AbiParam = {
  name: string;
  type: string;
  components?: AbiParam[];
  indexed?: boolean;
  internalType?: string;
};

/**
 * Loose function-entry shape used where only the inputs matter (arg
 * reshaping and validation).
 */
export type FunctionAbiEntry = {
  inputs?: AbiParam[];
};

export type AbiFunctionEntry = {
  type: "function";
  name: string;
  stateMutability: "view" | "pure" | "nonpayable" | "payable";
  inputs: AbiParam[];
  outputs: AbiParam[];
};

export type AbiEventEntry = {
  type: "event";
  name: string;
  inputs: AbiParam[];
  anonymous?: boolean;
};

export type AbiEntry =
  | AbiFunctionEntry
  | AbiEventEntry
  | { type: string; [key: string]: unknown };
