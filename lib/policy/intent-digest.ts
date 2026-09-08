import { createHash } from "node:crypto";

/** The selector segment used when a call carries no calldata. */
export const EMPTY_CALLDATA = "none";

const SELECTOR_LENGTH = 10;

/** The four-byte selector a calldata string starts with, or the empty marker. */
export function selectorOf(data: string | undefined | null): string {
  if (!data || data === "0x" || data.length < SELECTOR_LENGTH) {
    return EMPTY_CALLDATA;
  }
  return data.slice(0, SELECTOR_LENGTH).toLowerCase();
}

export type Intent = {
  chainId: number;
  /** The address on the wire. For a proxy, the proxy. */
  to: string;
  /** Four-byte selector, or the empty marker for a bare transfer. */
  selector: string;
  /** Native value in wei, as a decimal string. */
  valueWei: string;
};

/**
 * A content address for what an action will actually do.
 *
 * Computed independently by the node check and by the signer, from facts both
 * of them hold: the node knows the contract, the selector and the value before
 * encoding, and the signer reads the same three off the transaction. Full
 * calldata is deliberately not part of it, because the node does not have the
 * encoded form yet.
 *
 * Its job is to let the signing check recognise an action the node already
 * decided, so the two layers do not decide twice and do not charge twice.
 */
export function intentDigest(intent: Intent): string {
  const canonical = [
    String(intent.chainId),
    intent.to.toLowerCase(),
    intent.selector.toLowerCase(),
    intent.valueWei,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
