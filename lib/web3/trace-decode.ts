/**
 * Shared transaction trace decoding for web3 actions.
 *
 * Gas-sponsored transactions (Turnkey Gas Station, ERC-4337/EIP-7702 smart
 * accounts, generic relayers) do not appear on-chain as a direct call to the
 * target contract: the top-level `to` is the relayer/wrapper, and the real
 * call to the target is an internal call. Decoding only the top-level calldata
 * therefore returns different results for sponsored vs direct sends of the same
 * action.
 *
 * This module recovers the actual executed call(s) by walking the transaction's
 * internal call tree (`debug_traceTransaction` with the `callTracer`) and
 * decoding each frame against a contract ABI. The result is identical whether
 * the transaction was sponsored or sent directly, so any web3 action that holds
 * a transaction hash can report a normalized "what actually ran" view.
 *
 * Discovery caveat: this requires a transaction hash. It is suited to write
 * actions (which always have one). It cannot be used to discover sponsored
 * calls from explorer history alone, because explorers index internal calls by
 * value transfer only -- a zero-value sponsored call to a contract is not
 * listed against that contract.
 */
import "server-only";

import type { ethers } from "ethers";
import { serializeArg } from "@/lib/web3/serialize-arg";

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

/** A flattened call whose input was decoded against a contract ABI. */
export type DecodedCall = FlatCall & {
  functionName: string;
  functionSignature: string;
  args: Record<string, string>;
};

/** Normalized "what actually executed" view for a target contract. */
export type ExecutedCall = {
  /** The contract the decoded call actually hit. */
  contractAddress: string;
  functionName: string;
  functionSignature: string;
  args: Record<string, string>;
  /** True when the transaction was routed through a relayer/wrapper. */
  sponsored: boolean;
  /** Top-level `to` of the transaction (the wrapper, when sponsored). */
  topLevelTo: string;
  /** Whether the matched call frame reverted. */
  reverted: boolean;
};

/** Minimal provider surface needed for tracing (ethers JsonRpcProvider satisfies it). */
export type TraceProvider = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

const TRACE_METHOD = "debug_traceTransaction";
// Opcode types whose `input` carries calldata we can decode against an ABI.
const DECODABLE_CALL_TYPES: ReadonlySet<string> = new Set([
  "CALL",
  "DELEGATECALL",
  "STATICCALL",
  "CALLCODE",
]);

/**
 * Trace a transaction's internal call tree.
 *
 * Returns the root call frame, or `null` when the RPC does not support
 * `debug_traceTransaction`/`callTracer` or the hash is unknown. Callers should
 * treat `null` as "tracing unavailable" and degrade gracefully rather than
 * fail, since trace support varies by chain and RPC provider.
 */
export async function traceTransactionCallTree(
  provider: TraceProvider,
  txHash: string
): Promise<RawCallFrame | null> {
  try {
    const result = await provider.send(TRACE_METHOD, [
      txHash,
      { tracer: "callTracer" },
    ]);
    if (result && typeof result === "object") {
      return result as RawCallFrame;
    }
    return null;
  } catch {
    return null;
  }
}

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
    parentReverted: boolean
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

/**
 * Decode a single flattened call against an ABI interface.
 *
 * Returns `null` for non-decodable frames (creates, precompiles, value-only
 * sends) or when the calldata does not match any function in the interface.
 */
export function decodeFlatCall(
  call: FlatCall,
  iface: ethers.Interface
): DecodedCall | null {
  if (!DECODABLE_CALL_TYPES.has(call.type)) {
    return null;
  }
  if (call.input.length < 10) {
    return null;
  }

  try {
    const parsed = iface.parseTransaction({
      data: call.input,
      value: call.value,
    });
    if (!parsed) {
      return null;
    }

    const args: Record<string, string> = {};
    for (const [index, input] of parsed.fragment.inputs.entries()) {
      const name = input.name || `arg${index}`;
      args[name] = serializeArg(parsed.args[index]);
    }

    return {
      ...call,
      functionName: parsed.name,
      functionSignature: parsed.signature,
      args,
    };
  } catch {
    return null;
  }
}

function argFilterMatches(
  decoded: DecodedCall,
  iface: ethers.Interface,
  functionName: string,
  filterArgs: string[] | null
): boolean {
  if (filterArgs === null) {
    return true;
  }

  const fragment = iface.getFunction(functionName);
  if (!fragment) {
    return true;
  }

  for (const [index, filterValue] of filterArgs.entries()) {
    if (filterValue === "") {
      continue;
    }
    const paramName = fragment.inputs[index]?.name || `arg${index}`;
    const decodedValue = decoded.args[paramName] ?? "";
    if (filterValue.toLowerCase() !== decodedValue.toLowerCase()) {
      return false;
    }
  }
  return true;
}

export type FindCallOptions = {
  /** Restrict to calls hitting this address (case-insensitive). */
  target: string;
  iface: ethers.Interface;
  /** Restrict to a specific function name. */
  functionName?: string;
  /** Positional argument filter; "" entries are wildcards. */
  filterArgs?: string[] | null;
  /** Include reverted frames (default false). */
  includeReverted?: boolean;
};

/**
 * Find every decoded call to `target` in a trace tree that matches the given
 * function and argument filter. Frames are returned in execution order.
 */
export function findDecodedCalls(
  root: RawCallFrame | null,
  options: FindCallOptions
): DecodedCall[] {
  const target = options.target.toLowerCase();
  const includeReverted = options.includeReverted ?? false;
  const filterArgs = options.filterArgs ?? null;

  const matches: DecodedCall[] = [];
  for (const call of flattenCallTree(root)) {
    if (call.to !== target) {
      continue;
    }
    if (call.reverted && !includeReverted) {
      continue;
    }
    const decoded = decodeFlatCall(call, options.iface);
    if (!decoded) {
      continue;
    }
    if (options.functionName && decoded.functionName !== options.functionName) {
      continue;
    }
    if (
      !argFilterMatches(
        decoded,
        options.iface,
        decoded.functionName,
        filterArgs
      )
    ) {
      continue;
    }
    matches.push(decoded);
  }
  return matches;
}

/**
 * Resolve the normalized executed call for a transaction against a target
 * contract, transparently unwrapping sponsored/relayed routing.
 *
 * Returns `null` when tracing is unavailable or no matching call is found, so
 * callers can fall back to their pre-existing (top-level) behavior.
 */
export async function resolveExecutedCall(
  provider: TraceProvider,
  txHash: string,
  options: FindCallOptions
): Promise<ExecutedCall | null> {
  const root = await traceTransactionCallTree(provider, txHash);
  if (!root) {
    return null;
  }

  const matches = findDecodedCalls(root, options);
  const decoded = matches[0];
  if (!decoded) {
    return null;
  }

  const topLevelTo = (root.to ?? "").toLowerCase();
  return {
    contractAddress: decoded.to,
    functionName: decoded.functionName,
    functionSignature: decoded.functionSignature,
    args: decoded.args,
    sponsored: topLevelTo !== options.target.toLowerCase(),
    topLevelTo,
    reverted: decoded.reverted,
  };
}
