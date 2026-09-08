import "server-only";

import { BN, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  type AccountMeta,
  type PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { getErrorMessage } from "@/lib/utils";
import { isRecord, parsePublicKey } from "@/lib/web3/solana-account-reader";

// Structural types derived from anchor's Idl so we do not depend on the
// sub-types being re-exported from the package root (only Idl is).
type IdlInstruction = Idl["instructions"][number];
type IdlAccountItem = IdlInstruction["accounts"][number];
type IdlAccountGroup = Extract<IdlAccountItem, { accounts: unknown[] }>;
type IdlAccountLeaf = Exclude<IdlAccountItem, IdlAccountGroup>;
type IdlField = IdlInstruction["args"][number];
type IdlType = IdlField["type"];

const INTEGER = /^-?\d+$/;
const HEX_BODY = /^[0-9a-fA-F]*$/;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const TRAILING_PADDING = /=+$/;
const WHITESPACE = /\s+/g;

// 64-bit and wider integers must be passed to the borsh layout as BN; narrower
// integers and floats use plain numbers.
const WIDE_INT_TYPES = new Set(["u64", "i64", "u128", "i128", "u256", "i256"]);
const NUMBER_TYPES = new Set([
  "u8",
  "i8",
  "u16",
  "i16",
  "u32",
  "i32",
  "f32",
  "f64",
]);

/**
 * Thrown by the coercion helpers and converted to a returned error at the
 * encode boundary. Using an exception keeps the recursive coercion readable
 * instead of threading a result type through every level.
 */
class IdlCoercionError extends Error {}

/**
 * Validates the input parses as an Anchor IDL object with an instructions
 * array. The per-instruction discriminator (required by the coder and present
 * only in Anchor >= 0.30 IDLs) is checked later, per selected instruction.
 */
export function parseAnchorIdl(
  input: string | object
): { idl: Idl } | { error: string } {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      return { error: `IDL is not valid JSON: ${getErrorMessage(error)}` };
    }
  }

  if (!isRecord(parsed)) {
    return { error: "IDL must be a JSON object" };
  }
  if (!Array.isArray(parsed.instructions)) {
    return { error: "IDL is missing an instructions array" };
  }
  if (parsed.instructions.length === 0) {
    return { error: "IDL has no instructions" };
  }

  return { idl: parsed as Idl };
}

function toBN(value: unknown): BN {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new IdlCoercionError(`Expected an integer, got ${value}`);
    }
    return new BN(value);
  }
  if (typeof value === "string" && INTEGER.test(value.trim())) {
    return new BN(value.trim());
  }
  throw new IdlCoercionError(
    `Expected an integer (number or decimal string), got ${JSON.stringify(value)}`
  );
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new IdlCoercionError(`Expected a number, got ${JSON.stringify(value)}`);
}

function toPublicKey(value: unknown): PublicKey {
  if (typeof value !== "string") {
    throw new IdlCoercionError(
      `Expected a base58 pubkey string, got ${JSON.stringify(value)}`
    );
  }
  const key = parsePublicKey(value);
  if (!key) {
    throw new IdlCoercionError(`Invalid base58 pubkey: ${value}`);
  }
  return key;
}

function toBytes(value: unknown): Buffer {
  if (Array.isArray(value)) {
    for (const byte of value) {
      if (
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255
      ) {
        throw new IdlCoercionError(
          "bytes array must contain integers in the range 0-255"
        );
      }
    }
    return Buffer.from(value as number[]);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("0x")) {
      const body = trimmed.slice(2);
      if (body.length % 2 === 0 && HEX_BODY.test(body)) {
        return Buffer.from(body, "hex");
      }
      throw new IdlCoercionError(`Invalid hex bytes: ${trimmed}`);
    }
    // Mirror the raw-instruction action: Buffer.from silently drops characters
    // that do not form complete base64 groups, so confirm the decode is
    // lossless (padding-insensitive) rather than encode truncated bytes.
    const base64 = trimmed.replace(WHITESPACE, "");
    if (!BASE64_BODY.test(base64)) {
      throw new IdlCoercionError(`Invalid base64 bytes: ${trimmed}`);
    }
    const decoded = Buffer.from(base64, "base64");
    if (
      decoded.toString("base64").replace(TRAILING_PADDING, "") !==
      base64.replace(TRAILING_PADDING, "")
    ) {
      throw new IdlCoercionError(`Invalid base64 bytes: ${trimmed}`);
    }
    return decoded;
  }
  throw new IdlCoercionError(
    "bytes must be a number array, 0x-hex string, or base64 string"
  );
}

function coerceScalar(type: string, value: unknown): unknown {
  if (type === "bool") {
    if (typeof value !== "boolean") {
      throw new IdlCoercionError(
        `Expected a boolean, got ${JSON.stringify(value)}`
      );
    }
    return value;
  }
  if (WIDE_INT_TYPES.has(type)) {
    return toBN(value);
  }
  if (NUMBER_TYPES.has(type)) {
    return toNumber(value);
  }
  if (type === "string") {
    if (typeof value !== "string") {
      throw new IdlCoercionError(
        `Expected a string, got ${JSON.stringify(value)}`
      );
    }
    return value;
  }
  if (type === "pubkey") {
    return toPublicKey(value);
  }
  if (type === "bytes") {
    return toBytes(value);
  }
  throw new IdlCoercionError(`Unsupported IDL type: ${type}`);
}

function coerceArray(inner: IdlType, value: unknown, idl: Idl): unknown[] {
  if (!Array.isArray(value)) {
    throw new IdlCoercionError(
      `Expected an array, got ${JSON.stringify(value)}`
    );
  }
  return value.map((item) => coerceValue(inner, item, idl));
}

function coerceDefined(name: string, value: unknown, idl: Idl): unknown {
  const typeDef = idl.types?.find((entry) => entry.name === name);
  if (!typeDef) {
    throw new IdlCoercionError(`Unknown defined type: ${name}`);
  }
  if (typeDef.type.kind === "type") {
    return coerceValue(typeDef.type.alias, value, idl);
  }
  if (typeDef.type.kind !== "struct") {
    throw new IdlCoercionError(
      `Unsupported defined type "${name}": only structs and type aliases are supported`
    );
  }

  const fields = typeDef.type.fields ?? [];
  // Named struct fields are IdlField ({ name, type }); tuple fields are bare
  // IdlType. Use `in` so the check narrows the union without touching a
  // property the tuple variant lacks.
  const named = fields.every(
    (field) => isRecord(field) && "name" in field && "type" in field
  );
  if (!named) {
    throw new IdlCoercionError(
      `Unsupported defined type "${name}": tuple structs are not supported`
    );
  }
  if (!isRecord(value)) {
    throw new IdlCoercionError(
      `Expected an object for "${name}", got ${JSON.stringify(value)}`
    );
  }

  const out: Record<string, unknown> = {};
  for (const field of fields as IdlField[]) {
    out[field.name] = coerceValue(field.type, value[field.name], idl);
  }
  return out;
}

function coerceValue(type: IdlType, value: unknown, idl: Idl): unknown {
  if (typeof type === "string") {
    return coerceScalar(type, value);
  }
  if ("option" in type) {
    return value == null ? null : coerceValue(type.option, value, idl);
  }
  if ("coption" in type) {
    return value == null ? null : coerceValue(type.coption, value, idl);
  }
  if ("vec" in type) {
    return coerceArray(type.vec, value, idl);
  }
  if ("array" in type) {
    return coerceArray(type.array[0], value, idl);
  }
  if ("defined" in type) {
    return coerceDefined(type.defined.name, value, idl);
  }
  throw new IdlCoercionError(`Unsupported IDL type: ${JSON.stringify(type)}`);
}

function isOptionType(type: IdlType): boolean {
  return typeof type === "object" && ("option" in type || "coption" in type);
}

function coerceArgs(
  instruction: IdlInstruction,
  values: Record<string, unknown>,
  idl: Idl
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of instruction.args) {
    const raw = values[field.name];
    if (raw === undefined) {
      // Options default to None when omitted; everything else is required.
      if (isOptionType(field.type)) {
        out[field.name] = null;
        continue;
      }
      throw new IdlCoercionError(`Missing argument: ${field.name}`);
    }
    out[field.name] = coerceValue(field.type, raw, idl);
  }
  return out;
}

function isAccountGroup(item: IdlAccountItem): item is IdlAccountGroup {
  return (
    "accounts" in item &&
    Array.isArray((item as { accounts?: unknown }).accounts)
  );
}

function flattenAccounts(items: IdlAccountItem[]): IdlAccountLeaf[] {
  const out: IdlAccountLeaf[] = [];
  for (const item of items) {
    if (isAccountGroup(item)) {
      out.push(...flattenAccounts(item.accounts));
    } else {
      out.push(item);
    }
  }
  return out;
}

/**
 * Resolves each IDL account to a pubkey. Precedence: an explicit user value,
 * then a fixed address baked into the IDL (system program, sysvars), then the
 * org wallet for a signer slot the user did not fill. Any account the user
 * marks - via the IDL - as a signer must be the org wallet, since that is the
 * only key this action can sign with (mirrors the raw-instruction action).
 */
function resolveAccounts(
  instruction: IdlInstruction,
  accountPubkeys: Record<string, unknown>,
  walletPk: PublicKey
): { keys: AccountMeta[] } | { error: string } {
  const keys: AccountMeta[] = [];
  for (const account of flattenAccounts(instruction.accounts)) {
    const supplied = accountPubkeys[account.name];
    if (supplied !== undefined && typeof supplied !== "string") {
      return {
        error: `Account ${account.name} pubkey must be a base58 string`,
      };
    }

    let pubkeyStr: string | undefined = supplied ?? account.address;
    if (!pubkeyStr && account.signer) {
      pubkeyStr = walletPk.toBase58();
    }
    if (!pubkeyStr) {
      // MVP limitation: an unfilled optional account is dropped from the list,
      // which renumbers the accounts after it. Anchor programs that read a fixed
      // slot may instead expect the program ID as a placeholder in that
      // position; that convention (and PDA derivation) is deferred to the typed
      // account-resolution work. For now, callers must supply optional accounts
      // they want included.
      if (account.optional) {
        continue;
      }
      return { error: `Missing required account: ${account.name}` };
    }

    const pubkey = parsePublicKey(pubkeyStr);
    if (!pubkey) {
      return {
        error: `Invalid pubkey for account ${account.name}: ${pubkeyStr}`,
      };
    }
    if (account.signer && !pubkey.equals(walletPk)) {
      return {
        error: `Account ${account.name} is a signer, but only the organization wallet (${walletPk.toBase58()}) can sign`,
      };
    }

    keys.push({
      pubkey,
      isSigner: Boolean(account.signer),
      isWritable: Boolean(account.writable),
    });
  }

  return { keys };
}

/**
 * Encodes a single Anchor instruction from an IDL: Borsh-encodes the args with
 * the method discriminator via BorshInstructionCoder, and assembles the account
 * metas in IDL order. Returns a TransactionInstruction ready for the shared
 * Solana submit path, or a validation error.
 */
export function encodeAnchorInstruction(input: {
  idl: Idl;
  instructionName: string;
  args: Record<string, unknown>;
  accountPubkeys: Record<string, unknown>;
  programId: PublicKey;
  walletPk: PublicKey;
}): { instruction: TransactionInstruction } | { error: string } {
  const instruction = input.idl.instructions.find(
    (entry) => entry.name === input.instructionName
  );
  if (!instruction) {
    const available = input.idl.instructions
      .map((entry) => entry.name)
      .join(", ");
    return {
      error: `Instruction "${input.instructionName}" not found in IDL. Available: ${available}`,
    };
  }
  if (!Array.isArray(instruction.discriminator)) {
    return {
      error: `IDL instruction "${instruction.name}" has no discriminator; only Anchor >= 0.30 IDLs are supported`,
    };
  }

  let data: Buffer;
  try {
    const coerced = coerceArgs(instruction, input.args, input.idl);
    data = new BorshInstructionCoder(input.idl).encode(
      input.instructionName,
      coerced
    );
  } catch (error) {
    if (error instanceof IdlCoercionError) {
      return { error: error.message };
    }
    return { error: `Failed to encode instruction: ${getErrorMessage(error)}` };
  }

  const resolved = resolveAccounts(
    instruction,
    input.accountPubkeys,
    input.walletPk
  );
  if ("error" in resolved) {
    return { error: resolved.error };
  }

  return {
    instruction: new TransactionInstruction({
      programId: input.programId,
      keys: resolved.keys,
      data,
    }),
  };
}
