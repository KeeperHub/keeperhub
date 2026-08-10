/**
 * Server-derived payTo + amount verification for /sign.
 *
 * Phase 37 fix #2: closes the HMAC-compromise drain by reading the
 * recipient and amount from the workflows registry instead of trusting
 * the caller-supplied paymentChallenge. The wallet client (v0.1.5+)
 * forwards the workflowSlug extracted from the x402 resource.url.
 *
 * Phase 37 fix-pack-2 R2: the binding is now chain-aware. Base (x402) still
 * requires caller payTo + amount to match the registry. Tempo (MPP) proofs
 * carry neither field -- they prove ownership of a sub-org wallet for a
 * challenge id, and settlement happens elsewhere -- so the tempo path looks
 * up the workflow + price (still required for the fix-pack-2 R1 daily-spend
 * deduction) but skips the caller-side equality checks. This closes the
 * regression that made every priced tempo workflow 403 with PAYTO_MISMATCH
 * after fix #2 landed.
 *
 * Fix-pack-3 N-1: the caller-supplied chain is cross-checked against the
 * workflow's registered chain. Without this, an attacker with a stolen HMAC
 * secret + a dual-chain victim (both walletAddressBase and walletAddressTempo
 * populated) could claim chain="tempo" on a Base-registered workflow to slip
 * past the Base-side payTo/amount equality checks and mint an MPP proof
 * against the victim's tempo wallet. Permissive on null workflow.chain to
 * avoid breaking legacy listings that pre-date the column; log a metric when
 * the column is populated so ops can track coverage.
 *
 * Fix-pack-4 (KEEP-391): the chain match is now performed on a normalised
 * tag so listings stored with a numeric chain id ("8453", "4217", "4218")
 * compare equal to the caller's slug form ("base", "tempo"). Before this
 * fix, a listing with chain="8453" rejected every legitimate Base-USDC
 * payment with CHAIN_MISMATCH because the wallet's payViaX402 always sends
 * chain="base". Unknown / unparseable wf.chain values are treated as a
 * mismatch (defensive) rather than null (permissive) so we never silently
 * widen access on an unrecognised tag.
 *
 * Fix-pack-5 (KEEP-432): the chain field on a listing is overloaded — for
 * Base-data workflows the data chain and the payment chain happen to be the
 * same ("base"/"8453"), so the registered chain doubles as the payment-chain
 * pin. For workflows whose data chain is *not* a payment chain (Ethereum,
 * Optimism, Polygon, Arbitrum), the listing's chain identifies WHERE THE
 * CONTRACTS LIVE, not which chain payment must arrive on. Such listings now
 * accept either Base x402 or Tempo MPP. The defensive-mismatch behaviour for
 * unknown / unparseable tags is preserved — only enabled, non-testnet chains
 * in the `chains` table widen the payment side (see classifyChainTag).
 *
 * Security: even on data-chain listings the binding still server-derives
 * payTo from the registry on the Base path, and the Tempo path still resolves
 * the workflow's price for the daily-spend deduction. The fix-pack-3 N-1
 * concern (dual-chain victim, attacker chooses weaker chain) is unchanged for
 * Base- and Tempo-pinned listings. For data-chain listings there is no
 * payment-chain preference inherent to the workflow, so the pin doesn't apply.
 *
 * Note on creator degree-of-freedom: workflows.chain is a free-form text
 * column written by the listing API (lib/mcp/listing.ts) without an input
 * allowlist. A creator can intentionally tag a Base-only workflow with
 * chain="1" to widen acceptance to either payment chain. This isn't a
 * security boundary violation — payTo is still server-derived from the
 * org's wallet so payers are paying the legit creator regardless — but it
 * does mean which payment chains a listing accepts is author-controlled,
 * not platform-enforced. Tighten at the listing API if that ever becomes
 * a policy concern.
 *
 * An explicit multi-chain tag ("multi-chain", "any", "cross-chain", ...) is
 * treated like a data-chain listing: the workflow declares no single payment-
 * chain preference, so both Base x402 and Tempo MPP are accepted. This is the
 * supported way for a listing to say "payable on either rail" -- previously
 * the only ways to express it were a null chain or a data-chain id, and a
 * natural value like "multi-chain" fell through to the defensive-mismatch
 * branch and 403'd every payment on both rails. Unrecognised tags still stay
 * defensive so a typo never silently widens access.
 *
 * Lookup chain mirrors lib/x402/payment-gate.ts:resolveCreatorWallet.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chains, organizationWallets, workflows } from "@/lib/db/schema";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";
import {
  BASE_CHAIN_ID,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_TESTNET_CHAIN_ID,
} from "./constants";

export type BindingFailure = {
  ok: false;
  status: number;
  code:
    | "WORKFLOW_SLUG_REQUIRED"
    | "UNKNOWN_WORKFLOW"
    | "WORKFLOW_NOT_PAYABLE"
    | "PAYTO_MISMATCH"
    | "AMOUNT_MISMATCH"
    | "CHAIN_MISMATCH";
  error: string;
};

export type BindingOk = {
  ok: true;
  expectedPayTo: string;
  expectedAmountMicro: string;
  workflowId: string;
};

export type BindingResult = BindingOk | BindingFailure;

export type BindingChain = "base" | "tempo";

const USDC_DECIMALS = 6;

/**
 * Explicit "payable on either rail" tags. A listing carrying one of these
 * declares no single payment-chain preference, so the binding accepts both
 * Base x402 and Tempo MPP -- the same acceptance as a data-chain id or a null
 * chain. Matched case-insensitively after trim (see classifyChainTag). Not
 * chain data, so this stays a fixed vocabulary rather than a DB column.
 */
export const MULTI_CHAIN_TAGS = new Set<string>([
  "multi-chain",
  "multichain",
  "multi_chain",
  "multi",
  "cross-chain",
  "crosschain",
  "any",
  "all",
]);

type ChainClassification =
  | { readonly kind: "payment"; readonly chain: BindingChain }
  | { readonly kind: "data" }
  | { readonly kind: "multi" }
  | { readonly kind: "unrecognised" };

type ChainLookupRow = {
  chainId: number;
  aliases: string[];
  isTestnet: boolean;
  isPaymentRail: boolean;
};

const CHAIN_LOOKUP_TTL_MS = 60_000;
let chainLookupCache: { rows: ChainLookupRow[]; expiresAt: number } | null =
  null;

// Test-only seam: without this, the in-memory cache below survives across
// tests within the same file (module state is not reset between `it`
// blocks), so only the first test that classifies a chain tag would ever
// hit the mocked DB -- every later test would silently reuse its fixture.
export function _resetChainLookupCacheForTesting(): void {
  chainLookupCache = null;
}

/**
 * Enabled chains, cached briefly. Was previously two hardcoded shadows of
 * this table (KNOWN_DATA_CHAIN_IDS, DATA_CHAIN_SLUG_TO_ID) that never
 * tracked chains.isEnabled -- disabling a chain there did nothing to
 * payment-binding classification, and a chain seeded here but missing from
 * the hardcoded set (Optimism) was silently unclassifiable. The chains
 * table is tiny (~20 rows), so this is a single query rather than a
 * per-alias lookup.
 */
async function loadEnabledChains(): Promise<ChainLookupRow[]> {
  const cached = chainLookupCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }
  const rows = await db
    .select({
      chainId: chains.chainId,
      aliases: chains.aliases,
      isTestnet: chains.isTestnet,
      isPaymentRail: chains.isPaymentRail,
    })
    .from(chains)
    .where(eq(chains.isEnabled, true));
  const result = rows.map((row) => ({
    chainId: row.chainId,
    aliases: row.aliases ?? [],
    isTestnet: row.isTestnet ?? false,
    isPaymentRail: row.isPaymentRail,
  }));
  // Never cache an empty result. seed-chains.ts disables stale rows as part of
  // a seed run, and a DB restored ahead of its seed can legitimately return
  // nothing for a moment; caching that would keep every tag "unrecognised" for
  // a full TTL after the table is already correct. The expiry is stamped after
  // the query (not before it) so a slow query extends the usable window rather
  // than silently shortening it.
  if (result.length > 0) {
    chainLookupCache = {
      rows: result,
      expiresAt: Date.now() + CHAIN_LOOKUP_TTL_MS,
    };
  }
  return result;
}

/**
 * Which BindingChain a payment-rail chainId settles on. A DB row can say
 * "this is a payment rail" (chains.isPaymentRail); only these two ids are
 * wired into wallet routing, so the id-to-rail mapping stays a code
 * constant rather than a second DB column.
 */
function resolvePaymentRailChain(chainId: number): BindingChain | null {
  if (chainId === BASE_CHAIN_ID) {
    return "base";
  }
  if (
    chainId === TEMPO_MAINNET_CHAIN_ID ||
    chainId === TEMPO_TESTNET_CHAIN_ID
  ) {
    return "tempo";
  }
  return null;
}

/**
 * Payment-rail tags resolved from code, ahead of the chains table.
 *
 * The two rails are the chains the wallet actually settles on, and which one a
 * tag means is already a code constant (resolvePaymentRailChain, and the
 * BASE_/TEMPO_ ids in ./constants). Deriving the *tags* for them from the DB as
 * well made payment acceptance depend on seed state it has no business
 * depending on, and produced two live failures:
 *
 * - Shared alias, wrong row. seed-chains.ts stamps aliases ["tempo"] on both
 *   Tempo rows, and the testnet row's seeded chainId (42431) is not one
 *   resolvePaymentRailChain knows (4218). The unordered lookup below can match
 *   that row first, so `chain: "tempo"` collapsed to "unrecognised" and 403'd
 *   every Tempo payment. Until the 42431-vs-4218 seed mismatch is reconciled,
 *   the alias must not decide which rail a tag means.
 * - No rows at all. An unseeded PR environment, a migrate-only local DB, or a
 *   chains row disabled by config left even `chain: "base"` unrecognised -
 *   a defensive 403 on every priced listing, where the pre-table code path
 *   simply worked.
 *
 * The table still owns the data-chain vocabulary (aliases, enabled, testnet);
 * it just no longer gets a vote on the two rails.
 */
export const PAYMENT_RAIL_TAGS = new Map<string, BindingChain>([
  ["base", "base"],
  [String(BASE_CHAIN_ID), "base"],
  ["tempo", "tempo"],
  [String(TEMPO_MAINNET_CHAIN_ID), "tempo"],
  [String(TEMPO_TESTNET_CHAIN_ID), "tempo"],
]);

/**
 * Strict canonical decimal only: Number("08453") silently parses to 8453,
 * which would let a leading-zero typo widen acceptance to a real chain id
 * (KEEP-432 negative-set regression caught by
 * tests/unit/agentic-wallet-workflow-binding.test.ts). No leading zeros,
 * no hex, no floats.
 */
const CANONICAL_DECIMAL_RE = /^(0|[1-9]\d*)$/;

/**
 * Classify a workflow.chain tag into one of three buckets:
 * - "payment": a recognised payment-chain slug or chain id; the listing is
 *   pinned to that payment chain and the caller must match. Resolved from
 *   PAYMENT_RAIL_TAGS first (see the note there on why the rails do not go
 *   through the table), then from a table row flagged isPaymentRail whose id
 *   the wallet can actually route.
 * - "data": a recognised, enabled, non-testnet data chain; the listing's
 *   chain identifies where the contracts live, not which chain payment
 *   must arrive on. Either Base or Tempo payment is accepted. Testnets are
 *   excluded even when enabled in the chains table (for RPC/execution
 *   purposes) -- this preserves the historical mainnet-only scope of the
 *   marketplace acceptance list; a testnet has never been a valid data-chain
 *   listing tag.
 * - "multi": an explicit multi-chain tag (see MULTI_CHAIN_TAGS). The listing
 *   opts into either payment rail; accepted like a data-chain listing.
 * - "unrecognised": a non-empty value we can't parse, or a disabled chain.
 *   Treated as defensive mismatch by the binding so a typo, a disabled
 *   chain, or a future tag never silently widens access.
 *
 * Case-insensitive on slug input; whitespace-trimmed. Numeric forms match
 * chains.chainId directly, so a chain-id rename only happens in one place
 * (the chains table).
 */
export async function classifyChainTag(
  value: string | null | undefined
): Promise<ChainClassification> {
  if (typeof value !== "string") {
    return { kind: "unrecognised" };
  }
  const v = value.trim().toLowerCase();
  if (MULTI_CHAIN_TAGS.has(v)) {
    return { kind: "multi" };
  }
  const railChain = PAYMENT_RAIL_TAGS.get(v);
  if (railChain) {
    return { kind: "payment", chain: railChain };
  }
  const numericId = CANONICAL_DECIMAL_RE.test(v) ? Number(v) : null;
  const rows = await loadEnabledChains();
  const match = rows.find(
    (row) =>
      row.chainId === numericId ||
      row.aliases.some((alias) => alias.toLowerCase() === v)
  );
  if (!match) {
    return { kind: "unrecognised" };
  }
  if (match.isPaymentRail) {
    const chain = resolvePaymentRailChain(match.chainId);
    // A row flagged as a rail whose id the wallet cannot route (today: the
    // seeded Tempo testnet, chainId 42431) stays unrecognised rather than
    // falling through to the data-chain branch. Falling through would widen
    // that tag to accept BOTH rails, which is the opposite of what flagging it
    // a rail asked for.
    return chain ? { kind: "payment", chain } : { kind: "unrecognised" };
  }
  if (match.isTestnet) {
    return { kind: "unrecognised" };
  }
  return { kind: "data" };
}

function isChainTagCompatibleWithCaller(
  wfClass: ChainClassification,
  callerChain: BindingChain
): boolean {
  return (
    wfClass.kind === "data" ||
    wfClass.kind === "multi" ||
    (wfClass.kind === "payment" && wfClass.chain === callerChain)
  );
}

function priceToMicro(
  priceUsdcPerCall: string | null | undefined
): bigint | null {
  if (!priceUsdcPerCall) {
    return null;
  }
  const n = Number(priceUsdcPerCall);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

export async function verifyWorkflowBinding(
  slug: string | undefined | null,
  chain: BindingChain,
  payTo: string,
  amountMicro: string
): Promise<BindingResult> {
  if (!slug) {
    return {
      ok: false,
      status: 400,
      code: "WORKFLOW_SLUG_REQUIRED",
      error: "workflowSlug is required",
    };
  }

  const rows = await db
    .select({
      id: workflows.id,
      organizationId: workflows.organizationId,
      priceUsdcPerCall: workflows.priceUsdcPerCall,
      chain: workflows.chain,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.listedSlug, slug),
        eq(workflows.isListed, true),
        workflowNotDeleted()
      )
    )
    .limit(1);

  const wf = rows[0];
  if (!wf) {
    return {
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
      error: "Workflow not found or not listed",
    };
  }

  // Fix-pack-3 N-1 + Fix-pack-4 (KEEP-391) + Fix-pack-5 (KEEP-432): classify
  // the workflow's chain tag into payment / data / unrecognised. Payment-
  // chain listings stay pinned to that chain (the original cross-chain-proof
  // defence). Data-chain listings (Ethereum, Arbitrum, Polygon, BNB, Avalanche, 0G, Plasma) only
  // describe where the workflow READS contracts from — they have no inherent
  // payment-chain preference, so either Base x402 or Tempo MPP is accepted.
  // Explicit multi-chain tags opt into the same either-rail acceptance.
  // Unrecognised tags stay defensive (mismatch) so a typo never widens access.
  // A null wf.chain remains permissive for legacy listings that pre-date the
  // workflows.chain column.
  if (wf.chain) {
    const wfClass = await classifyChainTag(wf.chain);
    if (!isChainTagCompatibleWithCaller(wfClass, chain)) {
      return {
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
        error: "chain does not match workflow's registered chain",
      };
    }
  }

  const orgId = wf.organizationId;
  if (!orgId) {
    return {
      ok: false,
      status: 403,
      code: "WORKFLOW_NOT_PAYABLE",
      error: "Workflow has no organization",
    };
  }

  const walletRows = await db
    .select({ walletAddress: organizationWallets.walletAddress })
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, orgId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);
  const expectedPayTo = walletRows[0]?.walletAddress;

  const expectedMicro = priceToMicro(wf.priceUsdcPerCall);
  if (!expectedPayTo || expectedMicro === null) {
    return {
      ok: false,
      status: 403,
      code: "WORKFLOW_NOT_PAYABLE",
      error: "Workflow has no active wallet or price",
    };
  }

  if (chain === "base") {
    if (payTo.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return {
        ok: false,
        status: 403,
        code: "PAYTO_MISMATCH",
        error: "payTo does not match workflow creator wallet",
      };
    }

    let actualMicro: bigint;
    try {
      actualMicro = BigInt(amountMicro);
    } catch {
      return {
        ok: false,
        status: 403,
        code: "AMOUNT_MISMATCH",
        error: "amount is not a valid integer",
      };
    }
    if (actualMicro !== expectedMicro) {
      return {
        ok: false,
        status: 403,
        code: "AMOUNT_MISMATCH",
        error: "amount does not match workflow priceUsdcPerCall",
      };
    }
  }

  return {
    ok: true,
    expectedPayTo,
    expectedAmountMicro: expectedMicro.toString(),
    workflowId: wf.id,
  };
}
