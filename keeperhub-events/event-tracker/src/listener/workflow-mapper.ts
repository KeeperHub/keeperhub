import { createHash } from "node:crypto";
import { ethers } from "ethers";
import type {
  NetworksMap,
  RawWorkflow,
  RawWorkflowNodeConfig,
} from "../../lib/types";
import { logger } from "../../lib/utils/logger";
import { buildEventAbi } from "../chains/event-serializer";
import { redactRpcUrl } from "../chains/provider-manager";
import type { AbiEvent } from "../chains/validation";
import type {
  StateThresholdRegistration,
  WorkflowRegistration,
} from "./registry";
import type {
  StateThresholdSubscription,
  ThresholdComparator,
} from "./state-threshold";

/**
 * Maps the KeeperHub API workflow response shape into a WorkflowRegistration
 * suitable for ListenerRegistry.add(). Returns null for workflows that are
 * malformed (missing nodes, bad ABI JSON, unknown chainId). Callers should
 * skip null-returning workflows rather than throw.
 *
 * The input type (`RawWorkflow` from lib/types) has every field optional to
 * reflect that the KeeperHub API response is not runtime-validated; the
 * defensive per-field checks below are load-bearing, not dead-code.
 *
 * Extracted from main.ts so it can be unit-tested in isolation.
 */

export function buildRegistration(
  workflow: RawWorkflow,
  networks: NetworksMap,
): WorkflowRegistration | StateThresholdRegistration | null {
  const workflowId = typeof workflow.id === "string" ? workflow.id : null;
  if (!workflowId) {
    logger.warn("[workflow-mapper] workflow missing id; skipping");
    return null;
  }

  const node = workflow.nodes?.[0];
  if (!node?.data?.config) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} has no node config; skipping`,
    );
    return null;
  }
  const config = node.data.config;

  const chainIdStr = typeof config.network === "string" ? config.network : null;
  if (!chainIdStr) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} has no chainId in node.data.config.network; skipping`,
    );
    return null;
  }
  const chainId = Number(chainIdStr);
  if (!Number.isFinite(chainId)) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chainId "${chainIdStr}" is not numeric; skipping`,
    );
    return null;
  }
  const network = networks[chainId];
  if (!network) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} references unknown chainId ${chainId}; skipping`,
    );
    return null;
  }

  // The DB column `chains.default_primary_wss` is nullable, but
  // `NetworkConfig.defaultPrimaryWss` is typed `string`. Treat it as
  // `string | null | undefined` at runtime: an HTTP URL or empty string
  // pasted into this column would otherwise reach
  // `new ethers.WebSocketProvider(...)` and trigger an `eth_subscribe`
  // rejection that ethers' SocketSubscriber.start() leaves uncaught,
  // crashing the pod.
  const wssUrl: unknown = network.defaultPrimaryWss;
  if (typeof wssUrl !== "string" || wssUrl.length === 0) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chain ${chainId} has no defaultPrimaryWss; skipping`,
    );
    return null;
  }
  if (!(wssUrl.startsWith("wss://") || wssUrl.startsWith("ws://"))) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chain ${chainId} defaultPrimaryWss is not a WebSocket URL ("${redactRpcUrl(wssUrl)}"); skipping`,
    );
    return null;
  }

  // Fallback is optional. Same nullable-DB-column caveat as primary: the
  // type says `string` but rows can be null/empty. A bad fallback (wrong
  // scheme, empty) is logged and dropped rather than failing the whole
  // workflow; the listener still runs on primary alone.
  const rawFallbackWssUrl: unknown = network.defaultFallbackWss;
  let fallbackWssUrl: string | undefined;
  if (typeof rawFallbackWssUrl === "string" && rawFallbackWssUrl.length > 0) {
    if (
      rawFallbackWssUrl.startsWith("wss://") ||
      rawFallbackWssUrl.startsWith("ws://")
    ) {
      fallbackWssUrl = rawFallbackWssUrl;
    } else {
      logger.warn(
        `[workflow-mapper] workflow ${workflowId} chain ${chainId} defaultFallbackWss is not a WebSocket URL ("${redactRpcUrl(String(rawFallbackWssUrl))}"); ignoring fallback`,
      );
    }
  }

  const contractAddress =
    typeof config.contractAddress === "string" ? config.contractAddress : null;
  if (!contractAddress) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} missing contractAddress; skipping`,
    );
    return null;
  }

  // State-threshold trigger (issue #2240). Branches after the connection
  // fields because it shares every one of them and nothing below.
  if (config.triggerType === "stateThreshold") {
    return buildStateThresholdRegistration(workflow, workflowId, config, {
      chainId,
      wssUrl,
      fallbackWssUrl,
      contractAddress,
    });
  }

  const eventName =
    typeof config.eventName === "string" ? config.eventName : null;
  if (!eventName) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} missing eventName; skipping`,
    );
    return null;
  }

  const abiRaw =
    typeof config.contractABI === "string" ? config.contractABI : null;
  if (!abiRaw) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} missing contractABI; skipping`,
    );
    return null;
  }
  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abiRaw);
  } catch (err) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} has invalid contractABI JSON: ${String(err)}; skipping`,
    );
    return null;
  }
  if (!Array.isArray(parsedAbi)) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} contractABI is not an array; skipping`,
    );
    return null;
  }
  const rawEventsAbi = (parsedAbi as AbiEvent[]).filter(
    (entry) => entry?.type === "event",
  );
  if (rawEventsAbi.length === 0) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} contractABI contains no events; skipping`,
    );
    return null;
  }
  const eventsAbiStrings = rawEventsAbi.map(buildEventAbi);

  const userId = typeof workflow.userId === "string" ? workflow.userId : "";
  const workflowName = typeof workflow.name === "string" ? workflow.name : "";

  // Optional post-decode filters carried by the Transfer trigger.
  // Undefined for generic Event triggers, which never filter on decoded args.
  const recipientFilter =
    typeof config.recipientAddress === "string" &&
    config.recipientAddress.length > 0
      ? config.recipientAddress
      : undefined;
  const memoFilter =
    typeof config.memo === "string" && config.memo.length > 0
      ? config.memo
      : undefined;

  const registration: Omit<WorkflowRegistration, "configHash"> = {
    workflowId,
    userId,
    workflowName,
    chainId,
    wssUrl,
    fallbackWssUrl,
    contractAddress,
    eventName,
    eventsAbiStrings,
    rawEventsAbi,
    recipientFilter,
    memoFilter,
  };
  return {
    ...registration,
    configHash: hashRegistration(registration),
  };
}

/**
 * Content hash over the fields that affect listener behaviour. Used by the
 * reconciler to detect config changes (contract address swap, event name
 * rename, ABI update, user reassignment) and restart the listener. Excludes
 * `workflowId` (the lookup key) and `workflowName` (cosmetic).
 *
 * Stable across JSON round-trips because the input shape is fixed by
 * buildRegistration and all values are primitives or arrays of primitives.
 */
export function hashRegistration(
  reg: Omit<WorkflowRegistration, "configHash">,
): string {
  const canonical = JSON.stringify({
    chainId: reg.chainId,
    wssUrl: reg.wssUrl,
    fallbackWssUrl: reg.fallbackWssUrl ?? null,
    contractAddress: reg.contractAddress,
    eventName: reg.eventName,
    eventsAbiStrings: reg.eventsAbiStrings,
    userId: reg.userId,
    recipientFilter: reg.recipientFilter ?? null,
    memoFilter: reg.memoFilter ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const COMPARATORS: readonly ThresholdComparator[] = ["lt", "lte", "gt", "gte"];

/** `uint8` .. `uint256`, `int8` .. `int256`, and the bare aliases. */
const NUMERIC_BASE_TYPE = /^u?int\d*$/;

function isComparator(value: unknown): value is ThresholdComparator {
  return (
    typeof value === "string" &&
    (COMPARATORS as readonly string[]).includes(value)
  );
}

/**
 * Map a `stateThreshold` trigger node into a registration.
 *
 * The view call is resolved here, once, rather than in the listener: the
 * calldata, the output types and the comparable output index are all fixed
 * properties of the config, and resolving them at map time means a
 * misconfigured workflow is refused with one log line instead of failing to
 * decode on every drain forever.
 *
 * The output types in particular have to travel with the call. The decoder
 * gets raw return data and cannot recover the signature from it, and every
 * 32-byte word decodes cleanly as a `uint256` - so a decoder left to guess
 * would read an `int256` of -1 as 2^256 - 1 and silently turn a breach into a
 * comfortable value under an `lt` threshold.
 */
function buildStateThresholdRegistration(
  workflow: RawWorkflow,
  workflowId: string,
  config: RawWorkflowNodeConfig,
  connection: {
    chainId: number;
    wssUrl: string;
    fallbackWssUrl?: string;
    contractAddress: string;
  },
): StateThresholdRegistration | null {
  const abiRaw =
    typeof config.contractABI === "string" ? config.contractABI : null;
  if (!abiRaw) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} stateThreshold trigger missing contractABI; skipping`,
    );
    return null;
  }
  const abiFunction =
    typeof config.abiFunction === "string" ? config.abiFunction : null;
  if (!abiFunction) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} stateThreshold trigger missing abiFunction; skipping`,
    );
    return null;
  }
  if (!isComparator(config.comparator)) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} stateThreshold comparator "${String(config.comparator)}" is not one of ${COMPARATORS.join(", ")}; skipping`,
    );
    return null;
  }
  const comparator = config.comparator;

  let iface: ethers.Interface;
  let fragment: ethers.FunctionFragment | null;
  let callData: string;
  try {
    iface = new ethers.Interface(JSON.parse(abiRaw));
    fragment = iface.getFunction(abiFunction);
    if (!fragment) {
      logger.warn(
        `[workflow-mapper] workflow ${workflowId} contractABI has no function "${abiFunction}"; skipping`,
      );
      return null;
    }
    callData = iface.encodeFunctionData(
      fragment,
      Array.isArray(config.functionArgs) ? config.functionArgs : [],
    );
  } catch (err) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} could not encode "${abiFunction}": ${String(err)}; skipping`,
    );
    return null;
  }

  const outputs = fragment.outputs;
  if (outputs.length === 0) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} function "${abiFunction}" returns nothing to compare; skipping`,
    );
    return null;
  }
  // "full" rather than the bare `type`: a tuple output formats as `tuple`
  // alone, which carries none of its components and cannot be decoded.
  const outputTypes = outputs.map((output) => output.format("full"));

  const outputIndex = resolveOutputIndex(outputs, config.outputPath);
  if (outputIndex === null) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} outputPath "${String(config.outputPath)}" does not name an output of "${abiFunction}"; skipping`,
    );
    return null;
  }
  const selected = outputs[outputIndex];
  // `baseType` is the type name itself for a simple type ("uint256"), and
  // "array"/"tuple" otherwise, so the integer widths are matched rather than
  // compared to a bare "uint"/"int".
  if (!NUMERIC_BASE_TYPE.test(selected.baseType)) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} output "${selected.format("full")}" of "${abiFunction}" is not a numeric type; skipping`,
    );
    return null;
  }

  const decimals =
    typeof config.decimals === "number" && Number.isFinite(config.decimals)
      ? config.decimals
      : 0;
  const threshold = parseScaled(config.threshold, decimals);
  if (threshold === null) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} stateThreshold threshold "${String(config.threshold)}" is not a decimal number; skipping`,
    );
    return null;
  }
  // Undefined leaves the band at the module default. An unparseable value is
  // refused rather than defaulted: silently substituting a band the user did
  // not ask for is how an oscillating value becomes a burst of executions.
  let hysteresis: bigint | undefined;
  if (config.hysteresis !== undefined) {
    const parsed = parseScaled(config.hysteresis, decimals);
    if (parsed === null || parsed < 0n) {
      logger.warn(
        `[workflow-mapper] workflow ${workflowId} stateThreshold hysteresis "${String(config.hysteresis)}" is not a non-negative decimal number; skipping`,
      );
      return null;
    }
    hysteresis = parsed;
  }

  const minBlocksBetweenFires =
    typeof config.minBlocksBetweenFires === "number" &&
    Number.isFinite(config.minBlocksBetweenFires) &&
    config.minBlocksBetweenFires > 0
      ? Math.floor(config.minBlocksBetweenFires)
      : undefined;

  const subscription: StateThresholdSubscription = {
    // Placeholder until the semantic fields below are hashed into it.
    subscriptionId: "",
    workflowId,
    chainId: connection.chainId,
    contractAddress: connection.contractAddress,
    callData,
    outputTypes,
    outputIndex,
    threshold,
    comparator,
    hysteresis,
    minBlocksBetweenFires,
  };
  subscription.subscriptionId = hashStateSubscription(subscription);

  const userId = typeof workflow.userId === "string" ? workflow.userId : "";
  const workflowName = typeof workflow.name === "string" ? workflow.name : "";

  return {
    kind: "state",
    workflowId,
    userId,
    workflowName,
    chainId: connection.chainId,
    wssUrl: connection.wssUrl,
    fallbackWssUrl: connection.fallbackWssUrl,
    subscription,
    configHash: hashStateRegistration({
      subscriptionId: subscription.subscriptionId,
      wssUrl: connection.wssUrl,
      fallbackWssUrl: connection.fallbackWssUrl ?? null,
      userId,
    }),
  };
}

/** `outputPath` as an index, an output name, or absent (the first output). */
function resolveOutputIndex(
  outputs: readonly ethers.ParamType[],
  outputPath: string | number | undefined,
): number | null {
  if (outputPath === undefined || outputPath === "") {
    return 0;
  }
  if (typeof outputPath === "number") {
    return Number.isInteger(outputPath) &&
      outputPath >= 0 &&
      outputPath < outputs.length
      ? outputPath
      : null;
  }
  const byName = outputs.findIndex((output) => output.name === outputPath);
  if (byName >= 0) {
    return byName;
  }
  // A numeric string is an index, so the builder can send either shape.
  const asIndex = Number(outputPath);
  return Number.isInteger(asIndex) && asIndex >= 0 && asIndex < outputs.length
    ? asIndex
    : null;
}

/** Decimal string (or number) scaled by `decimals` into an integer. */
function parseScaled(
  value: string | number | undefined,
  decimals: number,
): bigint | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  try {
    return ethers.parseUnits(String(value), decimals);
  } catch {
    return null;
  }
}

/**
 * Identity of a state subscription's *trigger semantics*, and therefore of
 * its arming episodes. Deliberately excludes connection fields: rotating an
 * RPC URL must not open a new generation and re-dispatch a condition that is
 * already holding. Changing what is watched or where the line sits must, which
 * is why every one of those fields is in here.
 */
export function hashStateSubscription(
  sub: Omit<StateThresholdSubscription, "subscriptionId">,
): string {
  const canonical = JSON.stringify({
    workflowId: sub.workflowId,
    chainId: sub.chainId,
    contractAddress: sub.contractAddress.toLowerCase(),
    callData: sub.callData.toLowerCase(),
    outputTypes: sub.outputTypes,
    outputIndex: sub.outputIndex,
    threshold: sub.threshold.toString(),
    comparator: sub.comparator,
    hysteresis: sub.hysteresis?.toString() ?? null,
    minBlocksBetweenFires: sub.minBlocksBetweenFires ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Content hash over everything that should restart a state listener, which is
 * the subscription identity plus the connection fields it is served over.
 * Counterpart to `hashRegistration` for the event path.
 */
export function hashStateRegistration(parts: {
  subscriptionId: string;
  wssUrl: string;
  fallbackWssUrl: string | null;
  userId: string;
}): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
