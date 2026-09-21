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
 *   TRACE_CAPABLE_CHAIN_IDS=               unset or empty, default set applies
 *
 * Replaces rather than extends: a chain in the default set that this
 * deployment's upstream does not serve has to be removable, and an operator
 * listing their capable chains has already answered the whole question.
 */
export const TRACE_CAPABILITY_ENV_VAR = "TRACE_CAPABLE_CHAIN_IDS";

/** `*` in the override, meaning every chain is trusted to answer. */
const TRUST_EVERY_CHAIN = "*";

/**
 * Read once per call rather than at module load. The value is consulted once
 * per workflow mapped, which is not a hot path, and reading it live keeps the
 * override testable without a module-registry reset.
 *
 * Returns null when no override is configured, which is distinct from an
 * override that parses to an empty set: `TRACE_CAPABLE_CHAIN_IDS=0` is an
 * operator saying "no chain here traces" and is honoured.
 */
function configuredOverride(): ReadonlySet<number> | "all" | null {
  const raw = process.env[TRACE_CAPABILITY_ENV_VAR]?.trim();
  if (!raw) {
    return null;
  }
  if (raw === TRUST_EVERY_CHAIN) {
    return "all";
  }
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") {
      continue;
    }
    const parsed = Number(token);
    if (!Number.isInteger(parsed) || parsed < 0) {
      // Dropped rather than ignoring the whole override or throwing on
      // startup. Widening the set on a typo would admit a chain that goes
      // quiet, and emptying it would disable a trigger the operator enabled;
      // saying which token was dropped is the only useful answer.
      logger.warn(
        `[trace-capability] ${TRACE_CAPABILITY_ENV_VAR} entry "${token}" is not a chain ID; ignoring that entry`,
      );
      continue;
    }
    out.add(parsed);
  }
  return out;
}

/** Chain IDs currently treated as able to answer `debug_traceBlockByNumber`. */
export function traceCapableChainIds(): ReadonlySet<number> | "all" {
  return configuredOverride() ?? new Set(SURVEYED_TRACE_CAPABLE_CHAIN_IDS);
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
  const capable = traceCapableChainIds();
  if (capable === "all") {
    return `${TRACE_CAPABILITY_ENV_VAR}=${TRUST_EVERY_CHAIN}`;
  }
  const ids = [...capable].sort((a, b) => a - b);
  const source = process.env[TRACE_CAPABILITY_ENV_VAR]?.trim()
    ? TRACE_CAPABILITY_ENV_VAR
    : "surveyed default";
  return ids.length === 0
    ? `no chain is configured as trace-capable (${source})`
    : `trace-capable chains: ${ids.join(", ")} (${source})`;
}
