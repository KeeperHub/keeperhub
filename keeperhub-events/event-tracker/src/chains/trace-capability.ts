import { logger } from "../../lib/utils/logger";

/**
 * Which chains are known to answer `debug_traceBlockByNumber`.
 *
 * The Trace trigger is the only trigger whose upstream method is not
 * universally served. `eth_getLogs` is answered by every EVM endpoint in the
 * tree; `debug_traceBlockByNumber` sits in the debug namespace, which most
 * public endpoints and every surveyed commercial free tier refuse outright.
 *
 * What accepting a registration on such a chain costs: the first drain's
 * refusal sets `traceUnsupported` on the entry, emits one warn line, reports
 * the range served so the shared high-water mark keeps advancing, and stops
 * asking until the next reconnect. The workflow stays enabled and never
 * fires. Refusing at registration costs one warn line naming the chain, at a
 * point where `workflow-mapper.ts` already refuses every other trace filter
 * the matcher cannot honour.
 *
 * Provenance: `.planning/issue-2247-trace-upstream-survey.md`, which probed
 * `debug_traceBlockByNumber` unauthenticated against the primary and the
 * fallback of all 24 entries in the app's `CHAIN_CONFIG` / `PUBLIC_RPCS`. The
 * chain IDs below are cross-checked against `lib/rpc/rpc-config.ts`.
 *
 * Three classes of chain the survey found are deliberately NOT here:
 *
 * - Served only by the fallback: 0G mainnet (16661) and Robinhood testnet
 *   (46630), both via dRPC, whose own documentation puts debug on the paid
 *   tier. A capability that disappears on failover is not one to register a
 *   trigger against, and the survey says to treat those two answers as
 *   chain-specific leakage rather than a plan.
 * - Served `trace_block` but not `debug_traceBlockByNumber`: ETH Sepolia
 *   (11155111), OP Sepolia (11155420), and BSC testnet (97) on its PublicNode
 *   primary. `processTraces` calls the geth method and nothing here parses a
 *   Parity-shaped response.
 * - Everything the survey recorded as refusing: Ethereum, Base, Arbitrum,
 *   Polygon, BNB, OP, Avalanche, Robinhood mainnet, and both Solana networks
 *   (which have no EVM debug namespace at all).
 *
 * This is a default, not a law. See `TRACE_CAPABILITY_ENV_VAR`.
 */
const SURVEYED_TRACE_CAPABLE_CHAIN_IDS: readonly number[] = [
  // plasma-mainnet. Official `https://rpc.plasma.to` served callTracer, plus
  // trace_block and ots_*, without a key. 5-tx block, 63 kB, 212 ms.
  9745,
  // plasma-testnet. Official `https://testnet-rpc.plasma.to`, same methods.
  9746,
  // tempo-mainnet. Official `https://rpc.tempo.xyz` served callTracer and
  // trace_block. 1-tx block, 6.2 kB, 74 ms.
  4217,
  // tempo-testnet. Official `https://rpc.testnet.tempo.xyz`, same methods.
  42_431,
  // base-testnet (Base Sepolia). Official `https://sepolia.base.org` served
  // callTracer; trace_block and ots_* are unsupported there. The opposite of
  // Base mainnet, which refuses debug too, so the pair is easy to conflate.
  84_532,
];

/**
 * Environment override for the set above.
 *
 * The survey measured the tree-configured *public defaults*, and it records
 * explicitly that nobody has checked what the production `CHAIN_RPC_CONFIG`
 * resolves to. If production is on a keyed Alchemy PAYG or Infura Developer
 * plan then every chain the survey found refusing does serve the method
 * there, and a hard-coded default set would refuse workflows that would have
 * worked. So an operator who knows their upstreams states them:
 *
 *   TRACE_CAPABLE_CHAIN_IDS=1,8453,42161   replaces the default set
 *   TRACE_CAPABLE_CHAIN_IDS=*              trusts every chain
 *   TRACE_CAPABLE_CHAIN_IDS=none           trusts no chain; refuses every
 *                                          Trace registration
 *   TRACE_CAPABLE_CHAIN_IDS=               unset or empty, default set applies
 *
 * Replaces rather than extends: a chain in the default set that this
 * deployment's upstream does not serve has to be removable, and an operator
 * listing their capable chains has already answered the whole question.
 *
 * "No chain here traces" has to be sayable, and `none` is the only way to say
 * it. It used to be documented as `=0`, which did not work: `Number("0")` is
 * a valid integer, so that spelling produced the one-element set `{0}` and
 * every real chain was still refused -- the right answer for the wrong
 * reason, and an unreadable one in the refusal log line. `0` is now rejected
 * as a chain ID, since EIP-155 chain IDs start at 1.
 *
 * An override naming no usable chain at all -- every token a typo -- falls
 * back to the surveyed set with a warn rather than resolving to the empty
 * set. Resolving it to empty would turn off every Trace trigger in the
 * deployment, which is the outcome dropping a bad token exists to avoid, and
 * it would do so on the strength of a mistyped variable. An operator who
 * meant "none" now has a spelling that says so.
 */
export const TRACE_CAPABILITY_ENV_VAR = "TRACE_CAPABLE_CHAIN_IDS";

/** `*` in the override, meaning every chain is trusted to answer. */
const TRUST_EVERY_CHAIN = "*";

/** `none` in the override, meaning no chain is trusted to answer. */
const TRUST_NO_CHAIN = "none";

/** Provenance shown in the refusal log line when the surveyed set is in force. */
const SURVEYED_SOURCE = "surveyed default";

/**
 * The set in force plus where it came from.
 *
 * The provenance travels with the set rather than being recomputed from
 * `process.env` at log time. Reading the variable a second time to decide
 * what to blame is how `describeTraceCapableChains` came to claim
 * `TRACE_CAPABLE_CHAIN_IDS` for a set the override did not produce: the
 * variable is non-empty in the all-invalid case and the surveyed set is what
 * is actually in force.
 */
type Capability = {
  readonly chains: ReadonlySet<number> | "all";
  readonly source: string;
};

function surveyedCapability(): Capability {
  return {
    chains: new Set(SURVEYED_TRACE_CAPABLE_CHAIN_IDS),
    source: SURVEYED_SOURCE,
  };
}

function parseOverride(raw: string): Capability {
  if (raw === TRUST_EVERY_CHAIN) {
    return {
      chains: "all",
      source: `${TRACE_CAPABILITY_ENV_VAR}=${TRUST_EVERY_CHAIN}`,
    };
  }
  if (raw.toLowerCase() === TRUST_NO_CHAIN) {
    return {
      chains: new Set(),
      source: `${TRACE_CAPABILITY_ENV_VAR}=${TRUST_NO_CHAIN}`,
    };
  }

  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") {
      continue;
    }
    const parsed = Number(token);
    // EIP-155 chain IDs start at 1, so 0 is a typo rather than a chain. It
    // used to parse, which is what made the documented `=0` spelling for
    // "none" look like it worked.
    if (!Number.isInteger(parsed) || parsed < 1) {
      // Dropped rather than ignoring the whole override or throwing on
      // startup. Widening the set on a typo would admit a chain that goes
      // quiet; saying which token was dropped is the only useful answer.
      logger.warn(
        `[trace-capability] ${TRACE_CAPABILITY_ENV_VAR} entry "${token}" is not a chain ID; ignoring that entry`,
      );
      continue;
    }
    out.add(parsed);
  }

  if (out.size === 0) {
    // Every token was dropped. Honouring this as an empty set would refuse
    // every Trace registration in the deployment -- the operator set the
    // variable in order to enable chains, and a typo must not be read as the
    // opposite instruction. Fall back, and say so, because an operator who
    // mistyped every token must not silently get a policy they did not ask
    // for.
    logger.warn(
      `[trace-capability] ${TRACE_CAPABILITY_ENV_VAR}="${raw}" named no usable chain ID; falling back to the ${SURVEYED_SOURCE} set. Set ${TRACE_CAPABILITY_ENV_VAR}=${TRUST_NO_CHAIN} to refuse Trace registrations on every chain.`,
    );
    return surveyedCapability();
  }
  return { chains: out, source: TRACE_CAPABILITY_ENV_VAR };
}

/**
 * Resolution memoised on the raw variable value.
 *
 * Still effectively read live -- a different value re-resolves, which keeps
 * the override testable without a module-registry reset -- but a repeated
 * value is parsed once. That matters for the log: the refusal path asks twice
 * per workflow, once through `isTraceCapableChain` and once through
 * `describeTraceCapableChains`, and `synchronizeData` reconciles every 30
 * seconds (`src/index.ts`). Re-parsing on each call emitted the dropped-token
 * warn twice per workflow per reconcile, forever, for one typo.
 *
 * One consequence: callers now share the `Set` instance rather than getting a
 * fresh copy per call. `traceCapableChainIds` types it `ReadonlySet`, and the
 * two callers in this file only read it, so nothing can poison the cache
 * without casting the readonly away first.
 */
let resolved: { raw: string | undefined; capability: Capability } | null = null;

function resolveCapability(): Capability {
  const raw = process.env[TRACE_CAPABILITY_ENV_VAR]?.trim();
  if (resolved !== null && resolved.raw === raw) {
    return resolved.capability;
  }
  const capability = raw ? parseOverride(raw) : surveyedCapability();
  resolved = { raw, capability };
  return capability;
}

/**
 * Workflow+chain pairs whose map-time refusal has already been reported.
 *
 * `synchronizeData` reconciles every 30 seconds (`src/index.ts`) and re-maps
 * every workflow each time, so an unlatched refusal is one warn line per
 * enabled Trace workflow on a non-capable chain every 30 seconds for the life
 * of the pod. `recordTraceRefusal` already logs its runtime verdict once at
 * the transition for the same reason; this is that treatment for the
 * registration-time verdict.
 *
 * Keyed on the pair, not the workflow, so moving a workflow to a different
 * non-capable chain is a new fact and is reported. Bounded by the number of
 * Trace workflows that have ever been refused in this process.
 */
const reportedRefusals = new Set<string>();

function refusalKey(workflowId: string, chainId: number): string {
  return `${workflowId}:${chainId}`;
}

/**
 * Whether this refusal is new. True once per workflow+chain, then false.
 *
 * Latching suppresses the repeat, not the fact: `/healthz` and the runtime
 * `traceUnsupported` path are untouched by this, and a refused registration
 * never subscribes, so it never reaches them.
 */
export function shouldReportTraceRefusal(
  workflowId: string,
  chainId: number,
): boolean {
  const key = refusalKey(workflowId, chainId);
  if (reportedRefusals.has(key)) {
    return false;
  }
  reportedRefusals.add(key);
  return true;
}

/**
 * Forget a latched refusal, so a later one is reported again.
 *
 * Called when the pair registers successfully, which keeps this a transition
 * latch rather than a permanent gag: if the override changes such that the
 * chain becomes capable and later stops being, the operator hears about it
 * the second time too. The mirror of `reconnect()` clearing
 * `traceUnsupported` so the runtime verdict is re-learned.
 */
export function forgetTraceRefusal(workflowId: string, chainId: number): void {
  reportedRefusals.delete(refusalKey(workflowId, chainId));
}

/**
 * Drop the memoised resolution and the refusal latch. Tests only.
 *
 * The parse warns once per distinct value and the refusal warns once per
 * workflow+chain, so a test asserting that a warn is emitted at all needs a
 * defined starting point rather than inheriting state from whichever earlier
 * test used the same value or the same pair.
 */
export function resetTraceCapabilityCache(): void {
  resolved = null;
  reportedRefusals.clear();
}

/** Chain IDs currently treated as able to answer `debug_traceBlockByNumber`. */
export function traceCapableChainIds(): ReadonlySet<number> | "all" {
  return resolveCapability().chains;
}

/**
 * Whether a Trace registration on `chainId` should be accepted.
 *
 * This answers "is the method known to be served", not "is it served right
 * now". A chain that passes here and then refuses at runtime is still handled
 * by `recordTraceRefusal`, and that state now degrades `/healthz` rather than
 * only setting a field.
 */
export function isTraceCapableChain(chainId: number): boolean {
  const capable = traceCapableChainIds();
  return capable === "all" || capable.has(chainId);
}

/** The allowed set, for the log line that refuses a registration. */
export function describeTraceCapableChains(): string {
  const { chains, source } = resolveCapability();
  if (chains === "all") {
    return source;
  }
  const ids = [...chains].sort((a, b) => a - b);
  return ids.length === 0
    ? `no chain is configured as trace-capable (${source})`
    : `trace-capable chains: ${ids.join(", ")} (${source})`;
}
