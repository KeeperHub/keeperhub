import { createHash } from "node:crypto";
import type { NetworksMap, RawWorkflow } from "../../lib/types";
import { logger } from "../../lib/utils/logger";
import { buildEventAbi } from "../chains/event-serializer";
import { redactRpcUrl } from "../chains/provider-manager";
import type { AbiEvent } from "../chains/validation";
import type { WorkflowRegistration } from "./registry";

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
): WorkflowRegistration | null {
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
