/**
 * Call-frame matching for the Trace trigger, vendored from the app's own
 * `lib/web3/trace-decode.ts`.
 *
 * The tracker is a separate pnpm workspace with its own `rootDir`, and its
 * Docker build context is `keeperhub-events/`, not the repo root, so the app's
 * `lib/` is not on disk when the image is built. Sharing by import is not
 * available. Vendoring under `lib/` is how the tracker already shares code with
 * the other services, and it is what puts the flatten, the selector rule and
 * the filter under one definition instead of two.
 *
 * Four differences from the original, and only these:
 *
 * 1. `import "server-only"` is dropped. It is a Next.js app-boundary marker
 *    with no meaning in a standalone Node service, it is not a dependency of
 *    this package, and `pnpm deploy --prod --filter @techops/events-tracker`
 *    would not install it, so keeping the import would fail at runtime.
 * 2. The ABI-decoding half is not copied: `traceTransactionCallTree`,
 *    `decodeFlatCall`, `argFilterMatches`, `findDecodedCalls` and
 *    `resolveExecutedCall`, plus the `DecodedCall`, `ExecutedCall`,
 *    `TraceProvider` and `FindCallOptions` types. It needs `serializeArg` and
 *    an `ethers.Interface`, it traces one transaction by hash, and nothing
 *    here calls it.
 * 3. `frameMatches` is exported. The original's public seam is
 *    `matchTraceCalls`, which re-flattens the tree and returns bare frames;
 *    the tracker matches frames that already carry block and transaction
 *    metadata, so it needs the per-frame predicate.
 * 4. Formatting. The two workspaces run different biome configs (the app
 *    extends `ultracite`, this one does not), and they disagree about trailing
 *    commas in multi-line parameter lists, so a byte-identical copy does not
 *    pass `pnpm lint` here.
 *
 * `tests/unit/trace-decode-vendored.test.ts` compares every copied block
 * against the original with comments and formatting normalised away, so a
 * change to one side that is not made to the other fails CI rather than
 * drifting quietly.
 */

// --- copied from lib/web3/trace-decode.ts ---
/** A node of the `callTracer` output as returned by `debug_traceTransaction`. */
export type RawCallFrame = {
  type?: string;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
  output?: string;
  error?: string;
  calls?: RawCallFrame[];
};

/** A single call frame flattened out of the trace tree. */
export type FlatCall = {
  type: string;
  from: string;
  to: string;
  value: string;
  input: string;
  depth: number;
  reverted: boolean;
};

// --- copied from lib/web3/trace-decode.ts ---
// Opcode types whose `input` carries calldata we can decode against an ABI.
const DECODABLE_CALL_TYPES: ReadonlySet<string> = new Set([
  "CALL",
  "DELEGATECALL",
  "STATICCALL",
  "CALLCODE",
]);

// --- copied from lib/web3/trace-decode.ts ---
/** Depth-first flatten of the trace tree into an ordered list of call frames. */
export function flattenCallTree(root: RawCallFrame | null): FlatCall[] {
  const out: FlatCall[] = [];

  // parentReverted: true when any ancestor frame reverted. The EVM rolls back
  // all descendants of a reverted frame, but geth's callTracer only sets
  // `error` on the frame that reverted — not on its children. We propagate the
  // flag top-down so child frames that completed before their parent reverted
  // are correctly marked reverted too.
  const walk = (
    node: RawCallFrame | undefined,
    depth: number,
    parentReverted: boolean,
  ): void => {
    if (!node) {
      return;
    }
    const reverted = parentReverted || Boolean(node.error);
    out.push({
      type: (node.type ?? "CALL").toUpperCase(),
      from: (node.from ?? "").toLowerCase(),
      to: (node.to ?? "").toLowerCase(),
      value: node.value ?? "0x0",
      input: node.input ?? "0x",
      depth,
      reverted,
    });
    for (const child of node.calls ?? []) {
      walk(child, depth + 1, reverted);
    }
  };

  walk(root ?? undefined, 0, false);
  return out;
}

// --- copied from lib/web3/trace-decode.ts ---
/**
 * A block-trace trigger filter (issue #2241). Every field is optional and
 * unset fields are wildcards, so an empty filter matches every executed call
 * frame. Addresses are compared case-insensitively; the selector is the first
 * four calldata bytes; `minValue` is a wei threshold as a bigint.
 *
 * Unlike `findDecodedCalls`, this does not need an ABI: it matches on the raw
 * frame surface (`caller`, `callee`, `selector`, `value`, revert status), which
 * is exactly what `eth_getLogs` cannot see. A reverted drain attempt, an
 * internal ETH transfer, a `delegatecall` into an unlogged implementation, or
 * an unlogged privileged call all appear here even though they emit no event.
 */
export type TraceCallFilter = {
  /** Restrict to frames sent from this address (case-insensitive). */
  caller?: string;
  /** Restrict to frames whose `to` is this address (case-insensitive). */
  callee?: string;
  /**
   * Restrict to a 4-byte selector, e.g. "0x8456cb59" for `pause()`. Only
   * calldata-bearing frame types can match; see `callSelector`.
   */
  selector?: string;
  /**
   * Restrict to specific opcode call types, e.g. ["DELEGATECALL"]. An empty
   * array is a wildcard, matching the other unset-shaped values here, so a
   * trigger form that serialises an untouched multi-select as `[]` behaves the
   * same as one that omits the field.
   */
  callTypes?: readonly string[];
  /**
   * Minimum wei value moved by the frame.
   *
   * This counts every value-bearing frame `flattenCallTree` emits, including
   * CREATE with an endowment and SELFDESTRUCT sweeping a balance. Those are
   * real ETH movement and a security trigger that hid them would miss a drain,
   * so narrowing to plain calls is done with `callTypes` rather than assumed.
   */
  minValue?: bigint;
  /**
   * Which revert states to include:
   *   "success" - only frames that did not revert (default)
   *   "reverted" - only reverted frames (the highest-value security signal)
   *   "any" - both
   */
  status?: "success" | "reverted" | "any";
};

/**
 * The 4-byte selector of a call frame, or "0x" when it carries none.
 *
 * Frame types outside `DECODABLE_CALL_TYPES` never yield a selector. A CREATE
 * or CREATE2 frame carries init code in `input`, whose first four bytes are
 * constructor bytecode rather than a function selector, so reading one as a
 * selector would let a `selector` filter match a contract deployment. This
 * mirrors the `DECODABLE_CALL_TYPES` guard in `decodeFlatCall`.
 */
export function callSelector(call: FlatCall): string {
  if (!DECODABLE_CALL_TYPES.has(call.type)) {
    return "0x";
  }
  return call.input.length >= 10 ? call.input.slice(0, 10).toLowerCase() : "0x";
}

/**
 * The wei value a frame moves, or `null` when `value` cannot be parsed.
 *
 * `null` is distinct from `0n`: a frame that genuinely moves nothing must fail
 * a threshold, while one whose value is malformed is unknown and is surfaced
 * instead of silently dropped.
 */
function frameValueWei(call: FlatCall): bigint | null {
  try {
    return BigInt(call.value || "0x0");
  } catch {
    return null;
  }
}

export function frameMatches(call: FlatCall, filter: TraceCallFilter): boolean {
  const status = filter.status ?? "success";
  if (status === "success" && call.reverted) {
    return false;
  }
  if (status === "reverted" && !call.reverted) {
    return false;
  }
  if (filter.caller && call.from !== filter.caller.toLowerCase()) {
    return false;
  }
  if (filter.callee && call.to !== filter.callee.toLowerCase()) {
    return false;
  }
  if (filter.selector && callSelector(call) !== filter.selector.toLowerCase()) {
    return false;
  }
  if (
    filter.callTypes?.length &&
    !filter.callTypes.some((t) => t.toUpperCase() === call.type)
  ) {
    return false;
  }
  if (filter.minValue !== undefined) {
    const value = frameValueWei(call);
    // An unparseable value is surfaced rather than dropped. Returning 0n here
    // would make a malformed frame silently fail every threshold, and for a
    // value trigger the quiet direction is the unsafe one: the frame a filter
    // cannot price is exactly the one worth looking at.
    if (value !== null && value < filter.minValue) {
      return false;
    }
  }
  return true;
}
