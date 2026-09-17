/**
 * Pure rules for web3/disburse: parsing the leg list, the identity a leg is
 * compared on across runs, and what a run does with each leg given what the
 * ledger already holds. No database, no chain; the step core and the ledger
 * apply these.
 */

import type {
  DisbursementLeg,
  DisbursementLegStatus,
  TransactionHashEntry,
} from "@/lib/db/schema";

/** Upper bound on legs per node. A run sends them one at a time. */
export const MAX_DISBURSE_LEGS = 100;
export const MAX_RUN_KEY_LENGTH = 200;

/**
 * A claim that never reached the pre-broadcast hook cannot have broadcast, so
 * once it is this old the run that took it is presumed dead and another run
 * may take it over. This applies only to `claimed`. A leg in `sending` may
 * already be on chain and is never taken over, whatever its age.
 */
export const STALE_CLAIM_MS = 15 * 60 * 1000;

export type DisburseAssetKind = "native" | "erc20" | "spl";

export type LegInput = { recipient: string; amount: string };

/** What a leg pays, in the normalised form stored and compared. */
export type LegSpec = {
  index: number;
  chainId: number;
  asset: string;
  recipient: string;
  amount: string;
};

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRAILING_ZEROS = /0+$/;
const ZERO = /^0(?:\.0*)?$/;

/**
 * "1.50" and "1.5" pay the same, so they must compare equal across runs, or a
 * reformatted list would be refused as changed. Anything that is not a plain
 * positive decimal is rejected rather than coerced.
 */
export function canonicalAmount(raw: string): string | null {
  const s = raw.trim();
  if (!DECIMAL.test(s)) {
    return null;
  }
  const [whole, frac = ""] = s.split(".");
  const trimmedFrac = frac.replace(TRAILING_ZEROS, "");
  const canonical = trimmedFrac ? `${whole}.${trimmedFrac}` : whole;
  if (ZERO.test(canonical)) {
    return null;
  }
  return canonical;
}

export function assetKey(
  kind: DisburseAssetKind,
  tokenOrMint: string | undefined
): string | null {
  if (kind === "native") {
    return "native";
  }
  const id = (tokenOrMint ?? "").trim();
  if (id === "") {
    return null;
  }
  if (kind === "erc20") {
    return HEX_ADDRESS.test(id) ? `erc20:${id.toLowerCase()}` : null;
  }
  return `spl:${id}`;
}

/** EVM addresses compare case-insensitively; Solana base58 does not. */
export function recipientKey(recipient: string, isSolana: boolean): string {
  const r = recipient.trim();
  return isSolana ? r : r.toLowerCase();
}

export type ParsedLegs =
  | { ok: true; legs: LegInput[] }
  | { ok: false; error: string };

/**
 * The legs config: a JSON array (as text, which is what a template resolves
 * to) or an array, of `{recipient, amount}`. Order is the leg index, so a list
 * must be re-sent in the same order to resume.
 */
export function parseLegs(raw: unknown): ParsedLegs {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") {
      return { ok: false, error: "Legs are required" };
    }
    try {
      value = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: 'Legs must be a JSON array of {"recipient", "amount"} objects',
      };
    }
  }
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      error:
        'Legs must be a non-empty array of {"recipient", "amount"} objects',
    };
  }
  if (value.length > MAX_DISBURSE_LEGS) {
    return {
      ok: false,
      error: `At most ${MAX_DISBURSE_LEGS} legs per node (got ${value.length})`,
    };
  }
  const legs: LegInput[] = [];
  for (const [i, item] of value.entries()) {
    const leg = item as { recipient?: unknown; amount?: unknown } | null;
    if (leg === null || typeof leg !== "object") {
      return { ok: false, error: `Leg ${i} is not an object` };
    }
    if (typeof leg.recipient !== "string" || leg.recipient.trim() === "") {
      return { ok: false, error: `Leg ${i} has no recipient` };
    }
    const amount =
      typeof leg.amount === "number" ? String(leg.amount) : leg.amount;
    if (typeof amount !== "string" || canonicalAmount(amount) === null) {
      return {
        ok: false,
        error: `Leg ${i} amount must be a positive decimal string`,
      };
    }
    legs.push({ recipient: leg.recipient.trim(), amount: amount.trim() });
  }
  return { ok: true, legs };
}

export function validateRunKey(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const key = raw.trim();
  if (key === "" || key.length > MAX_RUN_KEY_LENGTH) {
    return null;
  }
  return key;
}

/** The field that differs, or null when the stored leg pays the same thing. */
export function specMismatch(
  spec: LegSpec,
  row: DisbursementLeg
): string | null {
  if (row.chainId !== spec.chainId) {
    return "network";
  }
  if (row.asset !== spec.asset) {
    return "asset";
  }
  if (row.recipient !== spec.recipient) {
    return "recipient";
  }
  if (row.amount !== spec.amount) {
    return "amount";
  }
  return null;
}

/**
 * What an earlier execution's receipt record says about a leg that went out.
 * Only a verified, successful receipt settles it and only a reverted one
 * fails it; everything else, including no entry at all, leaves it unknown.
 */
export function receiptVerdict(
  entries: TransactionHashEntry[] | null | undefined,
  hash: string
): "settled" | "failed" | "unknown" {
  const entry = entries?.find((e) => e.hash === hash);
  if (!entry) {
    return "unknown";
  }
  if (entry.verified === true && entry.receiptStatus === "success") {
    return "settled";
  }
  if (entry.receiptStatus === "reverted") {
    return "failed";
  }
  return "unknown";
}

export type LegPlan =
  | { action: "send"; reclaim: boolean }
  | { action: "already_paid"; transactionHash: string | null }
  | { action: "conflict"; field: string }
  | { action: "in_progress" }
  | { action: "check_evidence" };

/**
 * The decision for one leg before anything is sent. `check_evidence` means
 * the leg may have gone out and the caller must consult receiptVerdict: a
 * settled verdict becomes already_paid, failed becomes a reclaim, and unknown
 * stops the run.
 */
export function planLeg(
  spec: LegSpec,
  row: DisbursementLeg | undefined,
  now: Date
): LegPlan {
  if (!row) {
    return { action: "send", reclaim: false };
  }
  const mismatch = specMismatch(spec, row);
  if (mismatch) {
    return { action: "conflict", field: mismatch };
  }
  const status: DisbursementLegStatus = row.status;
  switch (status) {
    case "settled":
      return { action: "already_paid", transactionHash: row.transactionHash };
    case "failed":
      return { action: "send", reclaim: true };
    case "claimed":
      return now.getTime() - row.claimedAt.getTime() >= STALE_CLAIM_MS
        ? { action: "send", reclaim: true }
        : { action: "in_progress" };
    case "sending":
    case "unknown":
      return { action: "check_evidence" };
    default:
      return { action: "in_progress" };
  }
}
