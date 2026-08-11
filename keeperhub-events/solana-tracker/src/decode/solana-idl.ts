import { BorshEventCoder, type Idl } from "@coral-xyz/anchor";
import { logger } from "../../lib/utils/logger";

/**
 * Typed Anchor-event decoding for the Solana event listener (Phase 2).
 *
 * Anchor programs emit events as base64 blobs on a `Program data: <base64>`
 * log line (CPI events use `Program log:` with the same payload). We decode
 * those blobs against a program's Anchor IDL using Borsh, the analog of
 * decoding EVM event args from an ABI.
 *
 * The IDL is supplied in the trigger config (`config.idl`) - the UI fetches
 * the on-chain IDL (or takes a pasted one) and stores the JSON, so the watcher
 * never fetches on-chain itself. When no IDL is present the listener stays in
 * raw mode and this module is not used.
 */

const ANCHOR_EVENT_LOG_PREFIX = "Program data: ";

export interface DecodedAnchorEvent {
  name: string;
  data: Record<string, unknown>;
}

export class AnchorEventDecoder {
  private readonly coder: BorshEventCoder;

  constructor(idl: Idl) {
    this.coder = new BorshEventCoder(idl);
  }

  /**
   * Decode every Anchor event emitted in a transaction's log messages.
   * Non-event log lines and blobs that do not match the IDL are skipped.
   */
  decodeLogs(logs: string[]): DecodedAnchorEvent[] {
    const events: DecodedAnchorEvent[] = [];
    for (const line of logs) {
      if (!line.startsWith(ANCHOR_EVENT_LOG_PREFIX)) {
        continue;
      }
      const base64 = line.slice(ANCHOR_EVENT_LOG_PREFIX.length).trim();
      try {
        const decoded = this.coder.decode(base64);
        if (decoded) {
          events.push({
            name: decoded.name,
            data: decoded.data as Record<string, unknown>,
          });
        }
      } catch {
        // A blob that does not belong to this IDL is expected noise (other
        // programs' data lines); skip it rather than fail the whole tx.
      }
    }
    return events;
  }
}

/**
 * Parse an IDL JSON string and build a decoder. Returns null (raw mode) when
 * the string is absent, malformed, or not a usable Anchor IDL - the caller
 * degrades to emitting raw logs rather than dropping the event.
 */
export function createEventDecoder(
  idlJson: string | undefined,
  contextLabel: string,
): AnchorEventDecoder | null {
  if (!idlJson) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(idlJson);
  } catch (err) {
    logger.warn(
      `[solana-idl] ${contextLabel} idl is not valid JSON; falling back to raw mode: ${String(err)}`,
    );
    return null;
  }
  try {
    return new AnchorEventDecoder(parsed as Idl);
  } catch (err) {
    logger.warn(
      `[solana-idl] ${contextLabel} idl is not a usable Anchor IDL; falling back to raw mode: ${String(err)}`,
    );
    return null;
  }
}
