/**
 * Simulate as if the next block had already arrived (number + 1, timestamp +
 * one block time) via RPC block overrides. Only the go / no-go decision and
 * the gas estimate use it; the signed transaction is unchanged.
 */
import { AbiCoder, type ethers, isError, makeError, toQuantity } from "ethers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  isMethodNotFound,
  simulateV1Params,
  txForNode,
} from "@/lib/execute/node-call";
import { ErrorCategory, logUserError } from "@/lib/logging";
import type { RpcOperationType, RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import {
  MAX_SIMULATE_TIMESTAMP_OFFSET_SEC,
  MIN_SIMULATE_TIMESTAMP_OFFSET_SEC,
} from "@/lib/web3/next-block-limits";
import { extractRevertData } from "@/lib/web3/revert-data";

export type SimulateAt = "latest" | "next-block";

export type NextBlockSimulationOptions = {
  // Unset = the chain's observed block time.
  timestampOffsetSec?: number;
};

export type NextBlockSimulation = {
  mode: "next-block";
  baseBlock: number;
  assumedBlockNumber: number;
  assumedTimestamp: number;
  timestampOffsetSec: number;
  rpcMethod:
    | "eth_estimateGas+blockOverrides"
    | "eth_simulateV1"
    | "eth_call+blockOverrides";
};

export type SimulationTx = {
  from?: string;
  to: string;
  data: string;
  value?: bigint;
};

/**
 * The RPC or chain cannot simulate the next block. Never answered by falling
 * back to `latest`, and not retried: retrying the same endpoint cannot help,
 * and switching endpoints would move the chain's shared failover state.
 */
export class NextBlockSimulationUnsupportedError extends Error {
  readonly nonRetryable = true;

  constructor(message: string) {
    super(message);
    this.name = "NextBlockSimulationUnsupportedError";
  }
}

type ConfigFailure = {
  success: false;
  error: string;
  errorClass: typeof ExecutionErrorType.USER;
};

/**
 * The step result for an RPC or network that cannot simulate the next block,
 * logged so the rate of unsupported RPCs is visible.
 */
export function unsupportedFailure(
  error: NextBlockSimulationUnsupportedError,
  actionName: string
): ConfigFailure {
  logUserError(
    ErrorCategory.CONFIGURATION,
    "[Next-Block Simulation] Not supported by the network's RPC",
    error,
    { plugin_name: "web3", action_name: actionName }
  );
  return {
    success: false,
    error: error.message,
    errorClass: ExecutionErrorType.USER,
  };
}

const RPC_ADVICE =
  'Use an RPC for this network that supports it (see "RPC Preferences" in the API docs), or set "Simulate at" back to "Latest block".';
const RETRY_HINT =
  "a temporary RPC error, retried automatically; the next run or a re-run tries again";
const DETAIL_MAX_CHARS = 200;

function rpcErrorOf(error: unknown): { code?: number; message?: string } {
  const e = error as {
    info?: { error?: { code?: number; message?: string } };
    error?: { code?: number; message?: string };
  };
  return e.info?.error ?? e.error ?? {};
}

// The node's own message when ethers wrapped it, else ethers' short message,
// which unlike the full one carries no request URL. Capped.
function detailOf(error: unknown): string {
  const message =
    rpcErrorOf(error).message ??
    (error as { shortMessage?: string }).shortMessage ??
    getErrorMessage(error);
  return message.slice(0, DETAIL_MAX_CHARS);
}

function unsupported(what: string, error?: unknown): never {
  const detail = error === undefined ? "" : ` (${detailOf(error)})`;
  throw new NextBlockSimulationUnsupportedError(
    `Next-block simulation is not supported by this network's RPC: ${what}${detail}. ${RPC_ADVICE}`
  );
}

function retryable(method: string, error: unknown): Error {
  return new Error(
    `Next-block simulation: ${method} failed (${RETRY_HINT}): ${detailOf(error)}`
  );
}

type SettingsResult =
  | { ok: true; options: NextBlockSimulationOptions | undefined }
  | { ok: false; failure: ConfigFailure };

const INTEGER_PATTERN = /^\d+$/;

function settingsFailure(error: string): SettingsResult {
  return {
    ok: false,
    failure: { success: false, error, errorClass: ExecutionErrorType.USER },
  };
}

/** Reads the step's `simulateAt` / `simulateTimestampOffsetSec` config. */
export function parseSimulationSettings(
  simulateAt: unknown,
  timestampOffsetSec: unknown
): SettingsResult {
  const mode =
    typeof simulateAt === "string"
      ? simulateAt.trim().toLowerCase()
      : simulateAt;
  if (mode === undefined || mode === null || mode === "" || mode === "latest") {
    return { ok: true, options: undefined };
  }
  if (mode !== "next-block") {
    return settingsFailure(
      `Invalid Simulate at "${String(simulateAt)}": expected "latest" or "next-block"`
    );
  }
  if (
    timestampOffsetSec === undefined ||
    timestampOffsetSec === null ||
    timestampOffsetSec === ""
  ) {
    return { ok: true, options: {} };
  }
  const text = String(timestampOffsetSec).trim();
  const offset = Number(text);
  if (
    !INTEGER_PATTERN.test(text) ||
    offset < MIN_SIMULATE_TIMESTAMP_OFFSET_SEC ||
    offset > MAX_SIMULATE_TIMESTAMP_OFFSET_SEC
  ) {
    return settingsFailure(
      `Invalid Next block timestamp offset "${text}": expected a whole number of seconds from ${MIN_SIMULATE_TIMESTAMP_OFFSET_SEC} to ${MAX_SIMULATE_TIMESTAMP_OFFSET_SEC}`
    );
  }
  return { ok: true, options: { timestampOffsetSec: offset } };
}

// The proof: a contract creation whose init code succeeds only when TIMESTAMP
// equals the predicted time, and otherwise reverts with the time it saw. It
// needs no state override, so private relays that drop those still answer it.
// NUMBER is not checked: on Arbitrum chains it is the L1 block number.
function proofTx(time: number): Record<string, string> {
  const word = BigInt(time).toString(16).padStart(16, "0");
  return { data: `0x4267${word}146017574260005260206000fd5b00` };
}

const PROOF_REVERTED_PATTERN = /revert|vm execution error/i;

// Success proves the overrides applied. A failed proof means they were
// ignored when it reverted (with or without its data), are unsupported on a
// clear refusal, and is otherwise treated as a temporary error.
function proofFailure(
  reason: unknown
): "ignored" | "unsupported" | "transient" {
  const data = extractRevertData(reason);
  const { code, message = "" } = rpcErrorOf(reason);
  if (
    (data !== undefined && data.length > 2) ||
    code === EXECUTION_REVERTED_CODE ||
    PROOF_REVERTED_PATTERN.test(message)
  ) {
    return "ignored";
  }
  return classifyNodeError(reason) === "unsupported"
    ? "unsupported"
    : "transient";
}

const SLOT_SAMPLE_BLOCKS = 6;
const SLOT_CACHE_TTL_MS = 10 * 60_000;
const SLOT_CACHE_MAX_ENTRIES = 256;
const FALLBACK_SLOT_SECONDS = 12;
const slotSecondsCache = new Map<
  string,
  { seconds: number; expiresAt: number }
>();

// The smallest gap between recent blocks: exact on fixed-slot chains, and on
// variable ones never later than a block can carry. Cached per chain and RPC
// URL, so one org's custom RPC cannot set it for others.
async function chainSlotSeconds(
  provider: ethers.JsonRpcProvider,
  chainId: number,
  latest: ethers.Block
): Promise<number> {
  const key = `${chainId}:${provider._getConnection().url}`;
  const cached = slotSecondsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.seconds;
  }
  const first = Math.max(0, latest.number - SLOT_SAMPLE_BLOCKS);
  const numbers: number[] = [];
  for (let n = first; n < latest.number; n += 1) {
    numbers.push(n);
  }
  const earlier = await Promise.all(numbers.map((n) => provider.getBlock(n)));
  const timestamps = [
    ...earlier.flatMap((block) => (block ? [block.timestamp] : [])),
    latest.timestamp,
  ];
  let seconds = Number.POSITIVE_INFINITY;
  for (let i = 1; i < timestamps.length; i += 1) {
    seconds = Math.min(seconds, timestamps[i] - timestamps[i - 1]);
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    seconds = FALLBACK_SLOT_SECONDS;
  }
  seconds = Math.min(seconds, MAX_SIMULATE_TIMESTAMP_OFFSET_SEC);
  slotSecondsCache.delete(key);
  if (slotSecondsCache.size >= SLOT_CACHE_MAX_ENTRIES) {
    const oldest = slotSecondsCache.keys().next().value;
    if (oldest !== undefined) {
      slotSecondsCache.delete(oldest);
    }
  }
  slotSecondsCache.set(key, {
    seconds,
    expiresAt: Date.now() + SLOT_CACHE_TTL_MS,
  });
  return seconds;
}

/** Test hook: forget cached block times. */
export function clearSlotSecondsCache(): void {
  slotSecondsCache.clear();
}

type NodeErrorKind = "failed" | "unsupported" | "transient";

const UNSUPPORTED_PATTERN =
  /too many arguments|invalid (method )?param|unknown field|unexpected (field|argument)|not whitelisted|not allowed|not available|disabled/i;
const TRANSIENT_PATTERN =
  /header not found|unknown block|block not found|could not be found|missing trie node|rate limit|too many requests|(?<!execution aborted \()timed? ?out/i;
const INVALID_PARAMS_CODE = -32_602;
const METHOD_NOT_FOUND_CODE = -32_601;
const LIMIT_EXCEEDED_CODE = -32_005;
const EXECUTION_REVERTED_CODE = 3;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

// Some relays refuse a method with an HTTP 4xx (Flashbots Protect: 403), which
// ethers reports as SERVER_ERROR. Only 5xx and 429 are worth retrying.
function isRefusedOverHttp(error: unknown): boolean {
  if (!isError(error, "SERVER_ERROR")) {
    return false;
  }
  const status = (error as { response?: { statusCode?: number } }).response
    ?.statusCode;
  return (
    status !== undefined &&
    status >= HTTP_CLIENT_ERROR_MIN &&
    status < HTTP_SERVER_ERROR_MIN &&
    status !== HTTP_TOO_MANY_REQUESTS
  );
}

// ethers reports every eth_call / eth_estimateGas error as CALL_EXCEPTION, so
// the node's own answer decides. Only known transient answers are retried;
// anything else the node said about the call is final, as at `latest`.
function classifyNodeError(error: unknown): NodeErrorKind {
  const { code, message = "" } = rpcErrorOf(error);
  const data = extractRevertData(error);
  if (
    (data !== undefined && data.length > 2) ||
    code === EXECUTION_REVERTED_CODE
  ) {
    return "failed";
  }
  if (
    isRefusedOverHttp(error) ||
    code === INVALID_PARAMS_CODE ||
    code === METHOD_NOT_FOUND_CODE ||
    UNSUPPORTED_PATTERN.test(message) ||
    isMethodNotFound(message)
  ) {
    return "unsupported";
  }
  if (
    isError(error, "TIMEOUT") ||
    isError(error, "NETWORK_ERROR") ||
    isError(error, "SERVER_ERROR") ||
    code === LIMIT_EXCEEDED_CODE ||
    TRANSIENT_PATTERN.test(message)
  ) {
    return "transient";
  }
  return "failed";
}

const SIMULATION_KEY = "nextBlockSimulation";

function tagged(error: unknown, simulation: NextBlockSimulation): unknown {
  if (typeof error === "object" && error !== null) {
    Object.assign(error, { [SIMULATION_KEY]: simulation });
  }
  return error;
}

/** The predicted block a failed simulation ran against, if it got that far. */
export function getNextBlockSimulation(
  error: unknown
): NextBlockSimulation | undefined {
  if (typeof error !== "object" || error === null) {
    return;
  }
  return (error as { [SIMULATION_KEY]?: NextBlockSimulation })[SIMULATION_KEY];
}

/** A step's failure message and fields, with the predicted block when known. */
export function nextBlockFailure(
  message: string,
  error: unknown
): { error: string; simulation?: NextBlockSimulation } {
  const simulation = getNextBlockSimulation(error);
  if (!simulation) {
    return { error: message };
  }
  return {
    error: `${message} (simulated as of next block ${simulation.assumedBlockNumber}, timestamp ${simulation.assumedTimestamp})`,
    simulation,
  };
}

type Overrides = { number: string; time: string };

// Every call is pinned to the block the overrides were built from, so the
// simulated block always follows its base.
type Prepared = {
  blockTag: string;
  overrides: Overrides;
  time: number;
  simulation: NextBlockSimulation;
};

type SimulatedCall = {
  status?: string;
  gasUsed?: string;
  returnData?: string;
  error?: { data?: string; message?: string };
};

type SimulateV1Answer = { returnData: string; gasUsed: bigint };

function simulatedRevertData(call: SimulatedCall): string | null {
  if (call.error?.data) {
    return call.error.data;
  }
  return call.returnData && call.returnData !== "0x" ? call.returnData : null;
}

// One request: the real call and the proof in the same simulated block, so
// both answers come from the same node. Undefined = not usable here.
async function trySimulateV1(
  provider: ethers.JsonRpcProvider,
  tx: Record<string, string>,
  prepared: Prepared
): Promise<SimulateV1Answer | undefined> {
  const { blockTag, overrides, time } = prepared;
  let blocks: { calls?: SimulatedCall[] }[];
  try {
    blocks = await provider.send(
      "eth_simulateV1",
      simulateV1Params(
        [tx, proofTx(time)],
        { blockOverrides: overrides },
        blockTag
      )
    );
  } catch (error) {
    if (classifyNodeError(error) === "transient") {
      throw retryable("eth_simulateV1", error);
    }
    return;
  }
  const [call, proof] = blocks?.[0]?.calls ?? [];
  if (!(call?.gasUsed && proof?.status === "0x1")) {
    return;
  }
  if (call.status !== "0x1") {
    const revertData = simulatedRevertData(call);
    // Keep the node's reason (out of gas, invalid opcode) when there is no
    // revert data to decode.
    const exception =
      revertData === null && call.error?.message
        ? makeError(call.error.message, "CALL_EXCEPTION", {
            action: "call",
            data: null,
            reason: null,
            transaction: { to: tx.to ?? null, data: tx.data },
            invocation: null,
            revert: null,
            info: { error: call.error },
          })
        : AbiCoder.getBuiltinCallException("call", tx, revertData);
    throw tagged(exception, {
      ...prepared.simulation,
      rpcMethod: "eth_simulateV1",
    });
  }
  return {
    returnData: call.returnData ?? "0x",
    gasUsed: BigInt(call.gasUsed),
  };
}

async function ethCallAtNextBlock(
  provider: ethers.JsonRpcProvider,
  tx: Record<string, string>,
  prepared: Prepared
): Promise<string> {
  const { blockTag, overrides, time } = prepared;
  const [proof, call] = await Promise.allSettled([
    provider.send("eth_call", [proofTx(time), blockTag, {}, overrides]),
    provider.send("eth_call", [tx, blockTag, {}, overrides]) as Promise<string>,
  ]);
  if (proof.status === "rejected") {
    const outcome = proofFailure(proof.reason);
    if (outcome === "transient") {
      throw retryable("eth_call", proof.reason);
    }
    if (outcome === "ignored") {
      unsupported("eth_call ignored the block overrides");
    }
    unsupported("eth_call does not accept block overrides", proof.reason);
  }
  if (call.status === "rejected") {
    if (classifyNodeError(call.reason) === "transient") {
      throw retryable("eth_call", call.reason);
    }
    throw tagged(call.reason, prepared.simulation);
  }
  return call.value;
}

/**
 * eth_estimateGas with block overrides gives the revert check, the revert
 * reason and the success-path gas in one call, and is what private relays
 * such as Flashbots Protect accept. `refused` = it cannot take the overrides.
 */
async function tryEstimateAtNextBlock(
  provider: ethers.JsonRpcProvider,
  tx: Record<string, string>,
  prepared: Prepared
): Promise<bigint | { refused: string | undefined }> {
  const { blockTag, overrides, time, simulation } = prepared;
  const [proof, estimate] = await Promise.allSettled([
    provider.send("eth_estimateGas", [proofTx(time), blockTag, {}, overrides]),
    provider.send("eth_estimateGas", [
      tx,
      blockTag,
      {},
      overrides,
    ]) as Promise<string>,
  ]);
  if (proof.status === "rejected") {
    const failure = proofFailure(proof.reason);
    if (failure === "transient") {
      throw retryable("eth_estimateGas", proof.reason);
    }
    // Only a refusal says something about the RPC; an "ignored" proof's
    // revert would read as the user's own call reverting.
    return {
      refused: failure === "unsupported" ? detailOf(proof.reason) : undefined,
    };
  }
  if (estimate.status === "fulfilled") {
    return BigInt(estimate.value);
  }
  if (classifyNodeError(estimate.reason) === "transient") {
    throw retryable("eth_estimateGas", estimate.reason);
  }
  throw tagged(estimate.reason, simulation);
}

// gasUsed is net of refunds (up to a fifth of the gas spent) and leaves out
// the 1/64 that one level of nested calls keeps back.
function simulatedGas(simulateV1: SimulateV1Answer): bigint {
  return (simulateV1.gasUsed * BigInt(80)) / BigInt(63);
}

async function prepare(
  provider: ethers.JsonRpcProvider,
  chainId: number,
  options: NextBlockSimulationOptions
): Promise<Prepared> {
  const latest = await provider.getBlock("latest");
  if (!latest) {
    throw new Error(
      `Next-block simulation: the RPC returned no latest block (${RETRY_HINT})`
    );
  }
  const offset =
    options.timestampOffsetSec ??
    (await chainSlotSeconds(provider, chainId, latest));
  if (offset < MIN_SIMULATE_TIMESTAMP_OFFSET_SEC) {
    throw new NextBlockSimulationUnsupportedError(
      'Next-block simulation cannot predict the next block\'s time on this network: recent blocks share a timestamp. Set "Next block timestamp offset" to 1 (the call may then pass a few blocks early), or set "Simulate at" back to "Latest block".'
    );
  }
  const time = latest.timestamp + offset;
  return {
    blockTag: toQuantity(latest.number),
    time,
    overrides: {
      number: toQuantity(latest.number + 1),
      time: toQuantity(time),
    },
    simulation: {
      mode: "next-block",
      baseBlock: latest.number,
      assumedBlockNumber: latest.number + 1,
      assumedTimestamp: time,
      timestampOffsetSec: offset,
      rpcMethod: "eth_call+blockOverrides",
    },
  };
}

type NextBlockRequest = {
  chainId: number;
  tx: SimulationTx;
  options: NextBlockSimulationOptions;
};

/**
 * A read as of the next block: eth_simulateV1, else eth_call. `latest` is
 * read here, at simulation time. A revert is thrown as an ethers
 * CALL_EXCEPTION, like a staticCall.
 */
export async function simulateCallAtNextBlock(
  rpcManager: RpcProviderManager,
  request: NextBlockRequest & { operationType?: RpcOperationType }
): Promise<{ returnData: string; simulation: NextBlockSimulation }> {
  return await rpcManager.executeWithFailover(async (provider) => {
    const prepared = await prepare(provider, request.chainId, request.options);
    const tx = txForNode(request.tx.from, request.tx);
    const v1 = await trySimulateV1(provider, tx, prepared);
    if (v1) {
      return {
        returnData: v1.returnData,
        simulation: { ...prepared.simulation, rpcMethod: "eth_simulateV1" },
      };
    }
    const returnData = await ethCallAtNextBlock(provider, tx, prepared);
    return { returnData, simulation: prepared.simulation };
  }, request.operationType ?? "read");
}

/**
 * The revert check and gas estimate for a send, as of the next block:
 * eth_estimateGas with block overrides, else eth_simulateV1 gas.
 */
export async function simulateSendAtNextBlock(
  rpcManager: RpcProviderManager,
  request: NextBlockRequest
): Promise<{ gasEstimate: bigint; simulation: NextBlockSimulation }> {
  return await rpcManager.executeWithFailover(async (provider) => {
    const base = await prepare(provider, request.chainId, request.options);
    const tx = txForNode(request.tx.from, request.tx);
    const estimating: Prepared = {
      ...base,
      simulation: {
        ...base.simulation,
        rpcMethod: "eth_estimateGas+blockOverrides",
      },
    };
    const estimated = await tryEstimateAtNextBlock(provider, tx, estimating);
    if (typeof estimated === "bigint") {
      return { gasEstimate: estimated, simulation: estimating.simulation };
    }
    const v1 = await trySimulateV1(provider, tx, base);
    if (!v1) {
      const reason = estimated.refused ? ` (${estimated.refused})` : "";
      unsupported(
        `eth_estimateGas does not apply block overrides${reason}, and eth_simulateV1 is not available or ignored them`
      );
    }
    return {
      gasEstimate: simulatedGas(v1),
      simulation: { ...base.simulation, rpcMethod: "eth_simulateV1" },
    };
  }, "preflight");
}
