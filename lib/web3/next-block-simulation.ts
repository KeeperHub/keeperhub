/**
 * Simulate as if the next block had already arrived (number + 1, the next
 * block's predicted time) via RPC block overrides. Only the go / no-go decision and
 * the gas estimate use it; the signed transaction is unchanged.
 */
import { AbiCoder, type ethers, isError, makeError, toQuantity } from "ethers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { simulateV1Params, txForNode } from "@/lib/execute/node-call";
import { ErrorCategory, logUserError } from "@/lib/logging";
import type { RpcOperationType, RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import {
  MAX_SIMULATE_TIMESTAMP_OFFSET_SEC,
  MIN_SIMULATE_TIMESTAMP_OFFSET_SEC,
  parseSimulationSettings,
} from "@/lib/web3/next-block-limits";
import { extractRevertData } from "@/lib/web3/revert-data";

export type SimulateAt = "latest" | "next-block";

export type NextBlockSimulationOptions = {
  // Unset = the chain's observed block time.
  timestampOffsetSec?: number;
  // Reuse the block an earlier check predicted, so a batch's per-call check
  // and its send agree on one base block.
  basedOn?: NextBlockSimulation;
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
const UNSUPPORTED_ERROR_NAME = "NextBlockSimulationUnsupportedError";

export class NextBlockSimulationUnsupportedError extends Error {
  readonly nonRetryable = true;

  constructor(message: string) {
    super(message);
    this.name = UNSUPPORTED_ERROR_NAME;
  }
}

/**
 * Duck-typed, like the repo's other cross-bundle errors: `instanceof` fails
 * when the step bundle and lib/web3 hold separate copies of this module.
 */
export function isNextBlockSimulationUnsupported(
  error: unknown
): error is NextBlockSimulationUnsupportedError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === UNSUPPORTED_ERROR_NAME &&
    (error as { nonRetryable?: unknown }).nonRetryable === true
  );
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

function isTransportError(error: unknown): boolean {
  return (
    isError(error, "TIMEOUT") ||
    isError(error, "NETWORK_ERROR") ||
    isError(error, "SERVER_ERROR")
  );
}

// A transport error is rethrown unchanged, so the failover keeps its code,
// response and Retry-After. A node's own transient answer arrives as a
// non-retryable CALL_EXCEPTION, so it is wrapped, keeping it as `cause`.
function retryable(method: string, error: unknown): unknown {
  if (isTransportError(error) || !(error instanceof Error && "code" in error)) {
    return error;
  }
  return new Error(
    `Next-block simulation: ${method} failed (${RETRY_HINT}): ${detailOf(error)}`,
    { cause: error }
  );
}

type SettingsResult =
  | { ok: true; options: NextBlockSimulationOptions | undefined }
  | { ok: false; failure: ConfigFailure };

/** The step's settings, or the user error a bad value fails the step with. */
export function readSimulationSettings(
  simulateAt: unknown,
  timestampOffsetSec: unknown
): SettingsResult {
  const parsed = parseSimulationSettings(simulateAt, timestampOffsetSec);
  if (parsed.ok) {
    return parsed;
  }
  return {
    ok: false,
    failure: {
      success: false,
      error: parsed.error,
      errorClass: ExecutionErrorType.USER,
    },
  };
}

// The proof: a contract creation whose init code succeeds only when TIMESTAMP
// equals the predicted time, and otherwise reverts with the time it saw. It
// needs no state override, so private relays that drop those still answer it.
// NUMBER is not checked: on Arbitrum chains it is the L1 block number.
function proofTx(time: number): Record<string, string> {
  const word = BigInt(time).toString(16).padStart(16, "0");
  return { data: `0x4267${word}146017574260005260206000fd5b00` };
}

const PROOF_REVERTED_PATTERN = /vm execution error/i;

// Success proves the overrides applied. A failed proof means they were
// ignored when it reverted (with or without its data), are unsupported on a
// clear refusal, and is otherwise treated as a temporary error.
function proofFailure(
  reason: unknown
): "ignored" | "unsupported" | "transient" {
  const answer = nodeAnswer(reason);
  if (isRevert(answer) || PROOF_REVERTED_PATTERN.test(answer.message)) {
    return "ignored";
  }
  return classifyNodeError(reason) === "unsupported"
    ? "unsupported"
    : "transient";
}

const SLOT_SAMPLE_BLOCKS = 6;
const SLOT_CACHE_TTL_MS = 10 * 60_000;
const SLOT_CACHE_MAX_ENTRIES = 256;
// One gap may span a missed slot, so it takes two to trust the smallest.
const MIN_MEASURED_PAIRS = 2;
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
  const blocks = [...earlier, latest];
  // Only adjacent blocks that both came back: a gap across a missing one
  // would stretch the block time.
  let seconds = Number.POSITIVE_INFINITY;
  let pairs = 0;
  for (let i = 1; i < blocks.length; i += 1) {
    const previous = blocks[i - 1];
    const current = blocks[i];
    if (previous && current && current.number === previous.number + 1) {
      seconds = Math.min(seconds, current.timestamp - previous.timestamp);
      pairs += 1;
    }
  }
  // Too little measured. Guessing could send early, so fail as a temporary
  // error: retried, and the next run measures again.
  if (pairs < MIN_MEASURED_PAIRS || seconds < 0) {
    throw new Error(
      `Next-block simulation: could not read enough recent blocks to measure this network's block time (${RETRY_HINT}). Setting "Next block timestamp offset" skips the measurement.`
    );
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

// A refusal of the overrides themselves; checked before the transient
// answers, which share words such as "not available".
const OVERRIDES_REFUSED_PATTERN =
  /overrides?\b[^.]{0,40}(not supported|unsupported|not allowed|disabled|not available|not enabled)|(does not|doesn't|cannot) (support|accept)[^.]{0,20}overrides?/i;
// A block the node does not have yet, a rate limit, or an endpoint briefly
// unavailable.
const TRANSIENT_PATTERN =
  /(header|block)\b(?!\s*overrides?)[^.]{0,80}(not found|not available|not yet available|does not exist|could not be found)|unknown block|missing trie node|rate limit|too many requests|request limit reached|compute units|exceeded .{0,40}capacity|(?<!execution aborted \()timed? ?out|service unavailable|bad gateway|try again/i;
// The method refused by name, or the extra parameter rejected as malformed.
const METHOD_REFUSED_PATTERN =
  /unsupported method|\bmethod\s+(["'`]?[\w.]+["'`]?\s+)?(is\s+)?(not found|not supported|not available|does not exist|not allowed|disabled|not (white|allow)listed)|\beth_\w+\s+is\s+not\s+(white|allow)listed|too many arguments|invalid (method )?param|unknown field|unexpected (field|argument)/i;
// A revert reason is the contract's own text and may contain any words.
const REVERT_PATTERN = /revert/i;
const INVALID_PARAMS_CODE = -32_602;
const METHOD_NOT_FOUND_CODE = -32_601;
const LIMIT_EXCEEDED_CODE = -32_005;
// Rate limits some providers send as JSON-RPC errors (QuickNode, Alchemy).
const RATE_LIMIT_CODES = new Set<unknown>([-32_007, 429]);
const EXECUTION_REVERTED_CODE = 3;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

type HttpResponse = { statusCode?: number; bodyText?: string };

// The response of an HTTP 4xx other than 429, which ethers reports as a
// SERVER_ERROR.
function clientErrorResponse(error: unknown): HttpResponse | undefined {
  if (!isError(error, "SERVER_ERROR")) {
    return;
  }
  const response = (error as { response?: HttpResponse }).response;
  const status = response?.statusCode;
  if (
    status === undefined ||
    status < HTTP_CLIENT_ERROR_MIN ||
    status >= HTTP_SERVER_ERROR_MIN ||
    status === HTTP_TOO_MANY_REQUESTS
  ) {
    return;
  }
  return response;
}

type RpcErrorBody = { code?: unknown; message?: unknown; data?: unknown };

// The JSON-RPC error in an HTTP error body, if it has one.
function bodyRpcError(response: HttpResponse): RpcErrorBody {
  try {
    const body: unknown = JSON.parse(response.bodyText ?? "");
    const reply = Array.isArray(body) ? body[0] : body;
    return (reply as { error?: RpcErrorBody })?.error ?? {};
  } catch {
    // Not JSON (an HTML error page, or unreadable): says nothing.
    return {};
  }
}

// The node's answer, read the same way whether it came as a JSON-RPC error
// or inside an HTTP 4xx body (as Flashbots Protect answers, 403 + -32601).
type NodeAnswer = {
  code?: unknown;
  message: string;
  revertData?: string;
  viaHttp: boolean;
};

function nodeAnswer(error: unknown): NodeAnswer {
  const response = clientErrorResponse(error);
  if (response) {
    const { code, message, data } = bodyRpcError(response);
    return {
      code,
      message: typeof message === "string" ? message : "",
      revertData:
        typeof data === "string" && data.startsWith("0x") ? data : undefined,
      viaHttp: true,
    };
  }
  const { code, message = "" } = rpcErrorOf(error);
  return {
    code,
    message,
    revertData: extractRevertData(error),
    viaHttp: false,
  };
}

function isRevert(answer: NodeAnswer): boolean {
  return (
    (answer.revertData !== undefined && answer.revertData.length > 2) ||
    answer.code === EXECUTION_REVERTED_CODE ||
    REVERT_PATTERN.test(answer.message)
  );
}

// ethers reports every eth_call / eth_estimateGas error as CALL_EXCEPTION, so
// the node's own answer decides, in this order: a revert is final; a refusal
// of the overrides; known transient answers; a refusal of the method or its
// parameters. Anything else is final, as at `latest`, except an HTTP 4xx
// whose body says nothing decisive, which is the gateway's and is retried.
function classifyNodeError(error: unknown): NodeErrorKind {
  const answer = nodeAnswer(error);
  if (isRevert(answer)) {
    return "failed";
  }
  if (OVERRIDES_REFUSED_PATTERN.test(answer.message)) {
    return "unsupported";
  }
  if (
    (isTransportError(error) && !answer.viaHttp) ||
    TRANSIENT_PATTERN.test(answer.message) ||
    RATE_LIMIT_CODES.has(answer.code)
  ) {
    return "transient";
  }
  if (
    answer.code === INVALID_PARAMS_CODE ||
    answer.code === METHOD_NOT_FOUND_CODE ||
    METHOD_REFUSED_PATTERN.test(answer.message)
  ) {
    return "unsupported";
  }
  if (answer.viaHttp || answer.code === LIMIT_EXCEEDED_CODE) {
    return "transient";
  }
  return "failed";
}

// A failed call as ethers reports one, keeping the node's own reason (out of
// gas, invalid opcode) when there is no revert data to decode.
function callException(
  action: "call" | "estimateGas",
  tx: Record<string, string>,
  revertData: string | null,
  nodeError: { code?: unknown; message?: string }
): Error {
  if (revertData === null && nodeError.message) {
    return makeError(nodeError.message, "CALL_EXCEPTION", {
      action,
      data: null,
      reason: null,
      transaction: { to: tx.to ?? null, data: tx.data },
      invocation: null,
      revert: null,
      info: { error: nodeError },
    });
  }
  return AbiCoder.getBuiltinCallException(
    action,
    { to: tx.to ?? null, from: tx.from ?? null, data: tx.data },
    revertData
  );
}

// The user's own call failed for good. An answer inside an HTTP 4xx body
// would be retried as a transport error, so a revert is rebuilt as the
// CALL_EXCEPTION a normal answer gives, and a refusal (the only other final
// 4xx answer) is a non-retryable error with the node's message, as over 200.
function finalCallError(
  reason: unknown,
  action: "call" | "estimateGas",
  tx: Record<string, string>
): unknown {
  const answer = nodeAnswer(reason);
  if (!answer.viaHttp) {
    return reason;
  }
  if (isRevert(answer)) {
    return callException(action, tx, answer.revertData ?? null, answer);
  }
  return Object.assign(
    new Error(
      `Next-block simulation: ${action === "call" ? "eth_call" : "eth_estimateGas"} failed: ${answer.message || detailOf(reason)}`.slice(
        0,
        DETAIL_MAX_CHARS + 60
      ),
      { cause: reason }
    ),
    { nonRetryable: true }
  );
}

const SIMULATION_KEY = "nextBlockSimulation";

/**
 * Attaches the predicted block to an error, so a failure after the check
 * passed (broadcast, confirm, on-chain revert) still reports it.
 */
export function tagNextBlockSimulation(
  error: unknown,
  simulation: NextBlockSimulation
): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    Object.isExtensible(error) &&
    getNextBlockSimulation(error) === undefined
  ) {
    Object.assign(error, { [SIMULATION_KEY]: simulation });
  }
  return error;
}

const CHECK_FAILED_KEY = "nextBlockCheckFailed";

// Marks an error thrown by the next-block check itself: nothing was sent.
function markCheckFailed(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    Object.isExtensible(error)
  ) {
    Object.assign(error, { [CHECK_FAILED_KEY]: true });
  }
  return error;
}

/** Whether the next-block check failed before any send was attempted. */
export function failedNextBlockCheck(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [CHECK_FAILED_KEY]?: unknown })[CHECK_FAILED_KEY] === true
  );
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
  simulation: NextBlockSimulation | undefined
): { error: string; simulation?: NextBlockSimulation } {
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
      // The proof first, so a call that burns the block's gas cannot starve it.
      simulateV1Params(
        [proofTx(time), tx],
        { blockOverrides: overrides },
        blockTag
      )
    );
  } catch (error) {
    // Only a temporary answer is retried; any other failure leaves the
    // answer to eth_call, whose own proof decides.
    if (classifyNodeError(error) === "transient") {
      throw retryable("eth_simulateV1", error);
    }
    return;
  }
  const [proof, call] = blocks?.[0]?.calls ?? [];
  if (!(call?.gasUsed && proof?.status === "0x1")) {
    return;
  }
  if (call.status !== "0x1") {
    const revertData = simulatedRevertData(call);
    const exception = callException("call", tx, revertData, call.error ?? {});
    throw tagNextBlockSimulation(exception, {
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
    throw tagNextBlockSimulation(
      finalCallError(call.reason, "call", tx),
      prepared.simulation
    );
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
  throw tagNextBlockSimulation(
    finalCallError(estimate.reason, "estimateGas", tx),
    simulation
  );
}

// gasUsed is net of refunds (up to a fifth of the gas spent) and leaves out
// the 1/64 that one level of nested calls keeps back.
function simulatedGas(simulateV1: SimulateV1Answer): bigint {
  return (simulateV1.gasUsed * BigInt(80)) / BigInt(63);
}

function preparedFrom(simulation: NextBlockSimulation): Prepared {
  return {
    blockTag: toQuantity(simulation.baseBlock),
    time: simulation.assumedTimestamp,
    overrides: {
      number: toQuantity(simulation.assumedBlockNumber),
      time: toQuantity(simulation.assumedTimestamp),
    },
    simulation,
  };
}

const MS_PER_SECOND = 1000;
// Beacon chains keep to fixed wall-clock slots and leave a missed slot's
// timestamp unused: Ethereum, Sepolia, Holesky, Hoodi (12 s), Gnosis, Chiado (5 s).
const BEACON_SLOT_SECONDS = new Map<number, number>([
  [1, 12],
  [11_155_111, 12],
  [17_000, 12],
  [560_048, 12],
  [100, 5],
  [10_200, 5],
]);
// A slot counts as passed a third of the way in, while blocks are still built.
const SLOT_GRACE_FRACTION = 1 / 3;
// An older head means a lagging RPC, a wrong server clock or missing slots.
const STALE_HEAD_SLOTS = 5;

/**
 * The first slot (latest + n slots) a transaction sent now can still land in,
 * as a keeper on the beacon slot clock counts it; never before latest + 1 slot.
 */
export function nextSlotTime(
  latestTimestamp: number,
  slotSeconds: number,
  nowSeconds: number
): number {
  const grace = slotSeconds * SLOT_GRACE_FRACTION;
  const passed =
    Math.floor((nowSeconds - latestTimestamp - grace) / slotSeconds) + 1;
  return latestTimestamp + Math.max(1, passed) * slotSeconds;
}

// The next block's time: latest + block time, or on beacon chains the slot
// clock (relies on an accurate server clock), with a set offset as a minimum.
function predictedTime(
  chainId: number,
  latestTimestamp: number,
  offsetSeconds: number,
  nowSeconds: number
): number {
  const slot = BEACON_SLOT_SECONDS.get(chainId);
  if (slot === undefined) {
    return latestTimestamp + offsetSeconds;
  }
  const age = nowSeconds - latestTimestamp;
  if (age > STALE_HEAD_SLOTS * slot) {
    throw new Error(
      `Next-block simulation: the RPC's latest block is ${age}s old, more than ${STALE_HEAD_SLOTS} slots (${STALE_HEAD_SLOTS * slot}s), so the RPC may be lagging (${RETRY_HINT}). On a fork or test node, set "Simulate at" back to "Latest block".`
    );
  }
  return Math.max(
    nextSlotTime(latestTimestamp, slot, nowSeconds),
    latestTimestamp + offsetSeconds
  );
}

const currentSeconds = (): number => Math.floor(Date.now() / MS_PER_SECOND);

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
  const { basedOn } = options;
  // Reuse an earlier check's prediction only while nothing moved, so a wait
  // never sends on a stale check.
  if (
    basedOn &&
    latest.number === basedOn.baseBlock &&
    predictedTime(
      chainId,
      latest.timestamp,
      basedOn.timestampOffsetSec,
      currentSeconds()
    ) === basedOn.assumedTimestamp
  ) {
    return preparedFrom(basedOn);
  }
  if (basedOn && latest.number < basedOn.baseBlock) {
    throw new Error(
      `Next-block simulation: the RPC is behind the block the check ran on (${RETRY_HINT})`
    );
  }
  // On a beacon chain the fixed slot is the block time; a set offset can only
  // raise it, so the reported value is the one the prediction used.
  const beaconSlot = BEACON_SLOT_SECONDS.get(chainId);
  const offset =
    beaconSlot === undefined
      ? (options.timestampOffsetSec ??
        (await chainSlotSeconds(provider, chainId, latest)))
      : Math.max(options.timestampOffsetSec ?? beaconSlot, beaconSlot);
  if (offset < MIN_SIMULATE_TIMESTAMP_OFFSET_SEC) {
    throw new NextBlockSimulationUnsupportedError(
      'Next-block simulation cannot predict the next block\'s time on this network: recent blocks share a timestamp. Set "Next block timestamp offset" to 1 (the call may then pass a few blocks early), or set "Simulate at" back to "Latest block".'
    );
  }
  const time = predictedTime(
    chainId,
    latest.timestamp,
    offset,
    currentSeconds()
  );
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
  try {
    return await sendCheck(rpcManager, request);
  } catch (error) {
    throw markCheckFailed(error);
  }
}

async function sendCheck(
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
