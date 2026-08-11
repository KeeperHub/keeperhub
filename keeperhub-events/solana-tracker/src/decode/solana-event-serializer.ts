import { type SerializedArg, serializePrimitive } from "./serialize-primitives";
import type { DecodedAnchorEvent } from "./solana-idl";

/**
 * Builds the `triggerData` payload forwarded to the executor for a Solana
 * event. Mirrors the EVM `EventPayload` role: a flat, JSON-safe object whose
 * numeric/binary values are all stringified so nothing is lost across the SQS
 * boundary (the executor spreads `triggerData` verbatim).
 *
 * Solana-specific fields replace the EVM ones: `signature`/`slot`/`commitment`
 * instead of `transactionHash`/`blockNumber`/confirmation-depth, `programId`
 * instead of `address`. `logs` carries the raw program logs (Phase 1, always
 * present); `eventName`/`events` are populated only in typed mode (Phase 2).
 */

export interface SolanaDecodedEvent {
  name: string;
  data: Record<string, SerializedArg>;
}

export interface SolanaEventPayload {
  chainType: "solana";
  programId: string;
  signature: string;
  slot: number;
  commitment: string;
  logs: string[];
  eventName?: string;
  events?: SolanaDecodedEvent[];
}

interface PublicKeyLike {
  toBase58: () => string;
}

function isPublicKeyLike(value: object): value is PublicKeyLike {
  return typeof (value as PublicKeyLike).toBase58 === "function";
}

function isBigNumberLike(value: object): boolean {
  // Anchor decodes integer fields as bn.js BN instances, which carry a
  // `words` number array. Checked after PublicKey (which also has `_bn`) so
  // pubkeys serialize as base58 rather than as their internal bignum.
  return Array.isArray((value as { words?: unknown }).words);
}

/**
 * Recursively serialize a decoded Anchor value into a SerializedArg. BN and
 * bigint -> decimal string, PublicKey -> base58, byte arrays -> hex, keeping
 * every leaf a string like the EVM serializer does.
 */
export function serializeSolanaArg(value: unknown): SerializedArg {
  if (typeof value === "bigint") {
    return { value: value.toString(), type: "u64" };
  }
  if (value instanceof Uint8Array) {
    return { value: Buffer.from(value).toString("hex"), type: "bytes" };
  }
  if (Array.isArray(value)) {
    return {
      value: value.map((item) => serializeSolanaArg(item).value),
      type: "array",
    };
  }
  if (value && typeof value === "object") {
    if (isPublicKeyLike(value)) {
      return { value: value.toBase58(), type: "publicKey" };
    }
    if (isBigNumberLike(value)) {
      return { value: serializePrimitive(value), type: "u64" };
    }
    const record: Record<string, SerializedArg> = {};
    for (const [key, val] of Object.entries(value)) {
      record[key] = serializeSolanaArg(val);
    }
    return { value: record, type: "object" };
  }
  return { value: serializePrimitive(value), type: typeof value };
}

function serializeAnchorEvent(event: DecodedAnchorEvent): SolanaDecodedEvent {
  const data: Record<string, SerializedArg> = {};
  for (const [key, val] of Object.entries(event.data)) {
    data[key] = serializeSolanaArg(val);
  }
  return { name: event.name, data };
}

export function buildSolanaEventPayload(input: {
  programId: string;
  signature: string;
  slot: number;
  commitment: string;
  logs: string[];
  eventName?: string;
  decodedEvents?: DecodedAnchorEvent[];
}): SolanaEventPayload {
  const payload: SolanaEventPayload = {
    chainType: "solana",
    programId: input.programId,
    signature: input.signature,
    slot: input.slot,
    commitment: input.commitment,
    logs: input.logs,
  };
  if (input.eventName) {
    payload.eventName = input.eventName;
  }
  if (input.decodedEvents && input.decodedEvents.length > 0) {
    payload.events = input.decodedEvents.map(serializeAnchorEvent);
  }
  return payload;
}
