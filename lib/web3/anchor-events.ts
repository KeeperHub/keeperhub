import "server-only";

import { BN, BorshEventCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { ErrorCategory, logUserError } from "@/lib/logging";

// Anchor programs emit events as base64 blobs on a `Program data: <base64>`
// log line (sol_log_data), or on a bare `Program log: <base64>` line for the
// older/CPI self-invoke emission path - both carry the same payload shape.
// Which line "belongs" to which program is not encoded in the line itself:
// the runtime only tags `Program <id> invoke [depth]` / `Program <id>
// success` lines with an id, so decoding correctly requires tracking the
// execution-context stack across CPI boundaries the same way Anchor's own
// EventParser (@coral-xyz/anchor/src/program/event.ts) does - otherwise a
// CPI'd program's same-named event gets misattributed to the caller.
const PROGRAM_LOG_PREFIX = "Program log: ";
const PROGRAM_DATA_PREFIX = "Program data: ";
const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/;
const SUCCESS_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) success$/;
const ROOT_DEPTH = "1";

export type DecodedAnchorEvent = {
  name: string;
  data: Record<string, unknown>;
};

/**
 * Recursively converts the class instances Anchor's Borsh layout produces
 * into JSON-safe primitives, matching read-solana-program-core's
 * serializeAnchorValue: PublicKey -> base58, BN -> decimal string, byte
 * arrays -> base64.
 *
 * Every branch here exists because the instance would otherwise reach a
 * workflow author as an internal representation:
 * - BN (u64/i64/u128/i128 fields) has its own toJSON that emits a hex
 *   string, not the decimal amount expected.
 * - PublicKey (pubkey fields) survives JSON.stringify intact via toBase58,
 *   which hides the leak, but a structured-clone boundary deep-walks the
 *   instance into an opaque {"_bn":{"words":[...]}} object.
 * - Buffer/Uint8Array (bytes fields) serializes to {"type":"Buffer",
 *   "data":[...]} rather than usable bytes.
 */
function normalizeEventData(value: unknown): unknown {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (BN.isBN(value)) {
    return (value as InstanceType<typeof BN>).toString(10);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeEventData);
  }
  // Anchor resolves defined/option/vec types into plain objects, arrays and
  // nulls, so recursing into plain objects reaches every nested field - but
  // the instance branches above must come first, since a class instance is
  // also typeof "object" and would otherwise be walked into its internals.
  if (
    value !== null &&
    typeof value === "object" &&
    value.constructor === Object
  ) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = normalizeEventData(val);
    }
    return result;
  }
  return value;
}

export class AnchorEventDecoder {
  private readonly coder: BorshEventCoder;
  private readonly programId: string;

  constructor(idl: Idl, programId: string) {
    // BorshEventCoder's own constructor silently builds an empty layout map
    // (rather than throwing) when the IDL has no events array, which would
    // make decodeLogs always return [] with no signal that the IDL simply
    // cannot decode anything. Reject it here so the caller falls back to raw
    // mode instead of a permanently-empty decoded mode.
    if (!idl.events || idl.events.length === 0) {
      throw new Error("IDL has no events defined");
    }
    this.coder = new BorshEventCoder(idl);
    this.programId = programId;
  }

  /**
   * Decode every Anchor event emitted by this decoder's program in a
   * transaction's log messages, walking the CPI execution-context stack so
   * an event logged while a different invoked program is executing is never
   * attributed to this one. Degrades to returning no events (rather than
   * throwing, unlike Anchor's own parser) if the log array does not open
   * with a well-formed top-level invoke line - a single malformed
   * transaction's logs should not abort an entire backfill scan.
   */
  decodeLogs(logs: string[]): DecodedAnchorEvent[] {
    const events: DecodedAnchorEvent[] = [];
    const scanned = logs.filter((log) => log.startsWith("Program "));

    const first = scanned[0];
    if (!first) {
      return events;
    }
    const firstMatch = INVOKE_RE.exec(first);
    if (!firstMatch || firstMatch[2] !== ROOT_DEPTH) {
      return events;
    }

    const stack: string[] = [firstMatch[1]];
    for (let i = 1; i < scanned.length; i++) {
      const log = scanned[i];
      const executingProgram = stack.at(-1);

      if (executingProgram === this.programId) {
        const isData = log.startsWith(PROGRAM_DATA_PREFIX);
        const isLog = log.startsWith(PROGRAM_LOG_PREFIX);
        if (isData || isLog) {
          const encoded = isData
            ? log.slice(PROGRAM_DATA_PREFIX.length)
            : log.slice(PROGRAM_LOG_PREFIX.length);
          try {
            const decoded = this.coder.decode(encoded.trim());
            if (decoded) {
              events.push({
                name: decoded.name,
                data: normalizeEventData(decoded.data) as Record<
                  string,
                  unknown
                >,
              });
            }
          } catch {
            // A blob that does not belong to this IDL is expected noise
            // (other event lines, plain msg! text); skip it.
          }
          continue;
        }
      }

      const invokeMatch = INVOKE_RE.exec(log);
      if (invokeMatch) {
        stack.push(invokeMatch[1]);
        continue;
      }
      if (SUCCESS_RE.test(log)) {
        stack.pop();
      }
    }

    return events;
  }
}

/**
 * Parse an IDL JSON string and build a decoder scoped to `programId`.
 * Returns null (raw mode) when the string is absent, malformed, or not a
 * usable Anchor IDL - callers degrade to emitting raw logs rather than
 * failing, matching the live Solana event trigger's behavior. This is a
 * deliberate divergence from call-solana-program-anchor's hard-error IDL
 * handling: that action signs and spends, so a bad IDL must block execution;
 * this one only reads, so a bad IDL degrading to raw output is safe and more
 * useful than failing the whole query.
 */
export function createEventDecoder(
  idlJson: string | undefined,
  programId: string
): AnchorEventDecoder | null {
  if (!idlJson || idlJson.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(idlJson);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Solana IDL] idl is not valid JSON; falling back to raw mode",
      error
    );
    return null;
  }
  try {
    return new AnchorEventDecoder(parsed as Idl, programId);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Solana IDL] idl is not a usable Anchor IDL; falling back to raw mode",
      error
    );
    return null;
  }
}
