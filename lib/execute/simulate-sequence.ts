import "server-only";

import { ethers } from "ethers";
import {
  getRpcManagerForChain,
  type PreparedSimulationCall,
  prepareSimulationCall,
  resolveSimulationWallet,
  type SimulateResult,
  simulationFailure,
  simulationUnavailable,
} from "@/lib/execute/simulate";
import { MAX_SEQUENCE_CALLS } from "@/lib/execute/simulate-sequence-limits";
import { checkStablecoinContractCallBatch } from "@/lib/execute/stablecoin-cap";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import { decodeRevertReason } from "@/lib/web3/decode-revert-error";

/**
 * Dry runs an ordered sequence of calls, each against the state the previous
 * one produced.
 *
 * A single-call dry run resolves against latest state, so the second call of
 * an approve-then-deposit bundle reverts on allowance every time: the approve
 * has not landed. `eth_simulateV1` carries state across calls within one
 * request, which is the answer. Chains whose node does not implement it get
 * the same answer built from `debug_traceCall` state diffs replayed as
 * `eth_call` overrides.
 */

export type SimulateSequenceCall = {
  contractAddress: string;
  abi: string;
  functionName: string;
  functionArgs?: string;
  value?: string;
};

export type SimulateSequenceInput = {
  organizationId: string;
  network: string;
  calls: SimulateSequenceCall[];
};

/** Which node mechanism produced the answer. Absent when nothing ran. */
export type SequenceMechanism = "eth_simulateV1" | "state-overrides";

export type SimulateSequenceResult = {
  success: boolean;
  status: "simulated";
  from: string;
  /**
   * Always false, and stated rather than implied: these are N separate
   * transactions sent from the wallet in this order, not one bundle. Nothing
   * stops another transaction landing between them on the real chain.
   */
  atomic: false;
  mechanism: SequenceMechanism | null;
  /** One entry per call, in the order given. */
  results: SimulateResult[];
  wouldRevert: boolean;
  error?: string;
};

type EncodedCall = {
  to: string;
  data: string;
  value: bigint;
  iface: ethers.Interface;
  canonicalKey: string;
};

type RawCallResult = {
  status?: string;
  gasUsed?: string;
  returnData?: string;
  error?: { code?: number; message?: string; data?: string };
};

const mechanismByChain = new Map<number, SequenceMechanism>();

/** Exported for tests: capability is cached per chain for the process lifetime. */
export function resetSequenceMechanismCache(): void {
  mechanismByChain.clear();
}

function notRun(from: string, to: string, why: string): SimulateResult {
  return simulationUnavailable(from, to, BigInt(0), why);
}

function decodeReturnValue(
  call: EncodedCall,
  returnData: string | undefined
): unknown {
  if (!returnData || returnData === "0x") {
    return null;
  }
  try {
    const decoded = call.iface.decodeFunctionResult(
      call.canonicalKey,
      returnData
    );
    return decoded.length === 1 ? decoded[0] : Array.from(decoded);
  } catch {
    return returnData;
  }
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serialize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialize(v);
    }
    return out;
  }
  return value;
}

function success(
  from: string,
  call: EncodedCall,
  gasUsed: bigint,
  returnData: string | undefined
): SimulateResult {
  return {
    success: true,
    status: "simulated",
    from,
    to: call.to,
    value: call.value.toString(),
    gasEstimate: gasUsed.toString(),
    simulatedReturnValue: serialize(decodeReturnValue(call, returnData)),
    wouldRevert: false,
  };
}

function reverted(
  from: string,
  call: EncodedCall,
  err: unknown,
  fallbackMessage: string
): SimulateResult {
  const reason = decodeRevertReason(err, call.iface) ?? fallbackMessage;
  return {
    ...simulationFailure(from, call.to, call.value, reason, "revert"),
    originalError: fallbackMessage,
  };
}

function txForNode(from: string, call: EncodedCall): Record<string, string> {
  const tx: Record<string, string> = {
    from,
    to: call.to,
    data: call.data,
  };
  if (call.value > BigInt(0)) {
    tx.value = ethers.toQuantity(call.value);
  }
  return tx;
}

function isMethodNotFound(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();
  return (
    message.includes("method not found") ||
    message.includes("-32601") ||
    message.includes("does not exist") ||
    message.includes("not supported") ||
    message.includes("unsupported method")
  );
}

async function runSimulateV1(
  rpc: RpcProviderManager,
  from: string,
  calls: EncodedCall[]
): Promise<RawCallResult[]> {
  const params = [
    {
      blockStateCalls: [{ calls: calls.map((call) => txForNode(from, call)) }],
      // The caller is asking what the calls would do, not whether the wallet
      // is funded to send them, which is what the single-call path answers
      // too. Balance and nonce checks here would refuse a dry run that is
      // otherwise perfectly answerable.
      validation: false,
      traceTransfers: false,
    },
    "latest",
  ];
  const blocks = await rpc.executeWithFailover(
    (provider) =>
      provider.send("eth_simulateV1", params) as Promise<
        { calls?: RawCallResult[] }[]
      >,
    "preflight"
  );
  return blocks?.[0]?.calls ?? [];
}

/**
 * State overrides rebuilt from each call's own trace, for nodes without
 * `eth_simulateV1`. One round trip per call rather than one for the sequence.
 */
async function runWithStateOverrides(
  rpc: RpcProviderManager,
  from: string,
  calls: EncodedCall[]
): Promise<RawCallResult[]> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const results: RawCallResult[] = [];

  for (const [index, call] of calls.entries()) {
    const tx = txForNode(from, call);
    // A snapshot per call: the accumulator keeps growing, and executeWithFailover
    // re-runs the operation on a retry, so the object handed to the node must
    // not change underneath it.
    const stateAtThisCall = structuredClone(overrides);
    try {
      const [returnData, gasHex] = await rpc.executeWithFailover(
        (provider) =>
          Promise.all([
            provider.send("eth_call", [
              tx,
              "latest",
              stateAtThisCall,
            ]) as Promise<string>,
            provider.send("eth_estimateGas", [
              tx,
              "latest",
              stateAtThisCall,
            ]) as Promise<string>,
          ]),
        "preflight"
      );
      results.push({ status: "0x1", gasUsed: gasHex, returnData });
    } catch (err) {
      results.push({
        status: "0x0",
        error: {
          message: getErrorMessage(err),
          data: extractDataFromError(err),
        },
      });
      // The sequence is what the caller asked about, so keep going: the later
      // calls still answer against the state as it stands.
      continue;
    }

    // The last call's diff would seed a nonexistent next call, and it is the
    // most expensive trace of the sequence (largest accumulated
    // stateOverrides). Skip it.
    if (index === calls.length - 1) {
      continue;
    }

    try {
      // Trace against the same accumulated state the eth_call above used.
      // Without stateOverrides the node traces this call against the raw
      // latest chain state, so a call that only succeeds because an earlier
      // call set up state reverts here and its state changes never reach the
      // later calls -- exactly the failure this path exists to avoid.
      const traceOptions: Record<string, unknown> = {
        tracer: "prestateTracer",
        tracerConfig: { diffMode: true },
      };
      if (Object.keys(stateAtThisCall).length > 0) {
        traceOptions.stateOverrides = stateAtThisCall;
      }
      const diff = await rpc.executeWithFailover(
        (provider) =>
          provider.send("debug_traceCall", [
            tx,
            "latest",
            traceOptions,
          ]) as Promise<{ post?: Record<string, Record<string, unknown>> }>,
        "preflight"
      );
      mergeDiffIntoOverrides(overrides, diff?.post ?? {});
    } catch (err) {
      // Without the diff the next call sees state as if this one never ran,
      // which is the behaviour this whole path exists to avoid. Stop rather
      // than return answers that silently mean something else. Carry the node's
      // own error through so an operator can tell a capability refusal
      // (prestateTracer or stateOverrides missing) from a transport failure.
      results.push(
        ...unavailableRest(calls, results.length, getErrorMessage(err))
      );
      return results;
    }
  }
  return results;
}

function unavailableRest(
  calls: EncodedCall[],
  from: number,
  reason?: string
): RawCallResult[] {
  const detail =
    reason && reason.length > 0
      ? reason
      : "the node did not answer debug_traceCall with the prestateTracer trace and the accumulated state overrides";
  return calls.slice(from).map(() => ({
    error: {
      message: `Could not carry state to this call: ${detail}`,
    },
  }));
}

function extractDataFromError(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.data === "string") {
      return record.data;
    }
    for (const key of ["error", "info"]) {
      const nested = record[key];
      if (nested && typeof nested === "object") {
        const found = extractDataFromError(nested);
        if (found) {
          return found;
        }
      }
    }
  }
  return;
}

/**
 * prestateTracer in diffMode reports post-state as `storage`; `eth_call`
 * overrides take the same values under `stateDiff`. Balances and nonces carry
 * across unchanged.
 */
function mergeDiffIntoOverrides(
  overrides: Record<string, Record<string, unknown>>,
  post: Record<string, Record<string, unknown>>
): void {
  for (const [address, state] of Object.entries(post)) {
    const key = address.toLowerCase();
    const entry = overrides[key] ?? {};
    if (state.balance !== undefined) {
      entry.balance = state.balance;
    }
    if (state.nonce !== undefined) {
      entry.nonce =
        typeof state.nonce === "number"
          ? ethers.toQuantity(state.nonce)
          : state.nonce;
    }
    if (state.code !== undefined) {
      entry.code = state.code;
    }
    const storage = state.storage as Record<string, string> | undefined;
    if (storage) {
      entry.stateDiff = {
        ...((entry.stateDiff as Record<string, string>) ?? {}),
        ...storage,
      };
    }
    overrides[key] = entry;
  }
}

export async function simulateCallSequence(
  input: SimulateSequenceInput
): Promise<SimulateSequenceResult> {
  const firstTarget = input.calls[0]?.contractAddress ?? "";

  if (input.calls.length === 0) {
    return {
      success: false,
      status: "simulated",
      from: "",
      atomic: false,
      mechanism: null,
      results: [],
      wouldRevert: false,
      error: "calls must contain at least one call",
    };
  }
  if (input.calls.length > MAX_SEQUENCE_CALLS) {
    return {
      success: false,
      status: "simulated",
      from: "",
      atomic: false,
      mechanism: null,
      results: [],
      wouldRevert: false,
      error: `calls must contain at most ${MAX_SEQUENCE_CALLS} calls`,
    };
  }

  const fromOrFailure = await resolveSimulationWallet(
    input.organizationId,
    firstTarget,
    BigInt(0)
  );
  if (typeof fromOrFailure !== "string") {
    return {
      success: false,
      status: "simulated",
      from: "",
      atomic: false,
      mechanism: null,
      results: [fromOrFailure],
      wouldRevert: false,
      error: fromOrFailure.error,
    };
  }
  const from = fromOrFailure;

  const rpcResolution = await getRpcManagerForChain(input.network);
  if (!rpcResolution.success) {
    const asResult =
      rpcResolution.failureKind === "validation"
        ? simulationFailure(from, firstTarget, BigInt(0), rpcResolution.error)
        : simulationUnavailable(
            from,
            firstTarget,
            BigInt(0),
            rpcResolution.error
          );
    return {
      success: false,
      status: "simulated",
      from,
      atomic: false,
      mechanism: null,
      results: [asResult],
      wouldRevert: false,
      error: rpcResolution.error,
    };
  }
  const { rpc, chainId } = rpcResolution;

  // Encode every call first. A sequence with a call that cannot be encoded
  // has no meaningful answer for the calls after it, so nothing is sent to
  // the node: the bad call carries its error and the rest say why they did
  // not run.
  const encoded: EncodedCall[] = [];
  const prepared: PreparedSimulationCall[] = [];
  for (const [index, call] of input.calls.entries()) {
    const one = prepareSimulationCall(call);
    if ("error" in one) {
      return abortBefore(from, input, index, one.error, one.value);
    }
    prepared.push(one);
    encoded.push({
      to: one.to,
      data: one.data,
      value: one.value,
      iface: one.iface,
      canonicalKey: one.canonicalKey,
    });
  }

  // Per call, as the single-call path checks it: each is its own transaction
  // at broadcast.
  const cap = await checkStablecoinContractCallBatch({
    organizationId: input.organizationId,
    chainId,
    context: "simulate",
    calls: prepared.map((one, i) => ({
      contractAddress: one.to,
      functionName: one.abiFn.name ?? input.calls[i].functionName,
      inputTypes: (one.abiFn.inputs ?? []).map((arg) => arg.type),
      args: one.args,
    })),
  });
  if (cap.kind !== "allowed") {
    return abortBefore(
      from,
      input,
      cap.index,
      cap.error,
      encoded[cap.index].value
    );
  }

  const cached = mechanismByChain.get(chainId);
  let mechanism: SequenceMechanism = cached ?? "eth_simulateV1";
  let raw: RawCallResult[];

  if (mechanism === "eth_simulateV1") {
    try {
      raw = await runSimulateV1(rpc, from, encoded);
      mechanismByChain.set(chainId, "eth_simulateV1");
    } catch (err) {
      if (!isMethodNotFound(err)) {
        return sequenceUnavailable(from, encoded, getErrorMessage(err));
      }
      mechanism = "state-overrides";
      mechanismByChain.set(chainId, "state-overrides");
      try {
        raw = await runWithStateOverrides(rpc, from, encoded);
      } catch (fallbackErr) {
        return sequenceUnavailable(from, encoded, getErrorMessage(fallbackErr));
      }
    }
  } else {
    try {
      raw = await runWithStateOverrides(rpc, from, encoded);
    } catch (err) {
      return sequenceUnavailable(from, encoded, getErrorMessage(err));
    }
  }

  const results = encoded.map((call, index) => {
    const answer = raw[index];
    if (!answer) {
      return notRun(
        from,
        call.to,
        "Simulation unavailable: the node returned no result for this call"
      );
    }
    if (answer.status === "0x1") {
      return success(
        from,
        call,
        BigInt(answer.gasUsed ?? "0x0"),
        answer.returnData
      );
    }
    if (!answer.status && answer.error) {
      return notRun(
        from,
        call.to,
        `Simulation unavailable: ${answer.error.message}`
      );
    }
    return reverted(
      from,
      call,
      answer.error,
      answer.error?.message ?? "The call would revert"
    );
  });

  return {
    success: results.every((r) => r.success),
    status: "simulated",
    from,
    atomic: false,
    mechanism,
    results,
    wouldRevert: results.some((r) => r.wouldRevert),
  };
}

function abortBefore(
  from: string,
  input: SimulateSequenceInput,
  index: number,
  message: string,
  value: bigint
): SimulateSequenceResult {
  const results = input.calls.map((call, i) => {
    if (i === index) {
      return simulationFailure(from, call.contractAddress, value, message);
    }
    return notRun(
      from,
      call.contractAddress,
      `Not simulated: call ${index + 1} of the sequence did not validate`
    );
  });
  return {
    success: false,
    status: "simulated",
    from,
    atomic: false,
    mechanism: null,
    results,
    wouldRevert: results.some((r) => r.wouldRevert),
    error: message,
  };
}

function sequenceUnavailable(
  from: string,
  encoded: EncodedCall[],
  message: string
): SimulateSequenceResult {
  const why = `Simulation unavailable: ${message}`;
  return {
    success: false,
    status: "simulated",
    from,
    atomic: false,
    mechanism: null,
    results: encoded.map((call) => notRun(from, call.to, why)),
    wouldRevert: false,
    error: why,
  };
}
