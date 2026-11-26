/**
 * Per-step record of which RPC endpoints served a workflow step or a direct
 * execution. The engine notes every client it hands out and every call it
 * makes; the step wrapper reads the note when the step completes.
 *
 * Reachable from the workflow runtime bundle, which forbids Node builtins, so
 * this module holds no static `node:` import. The AsyncLocalStorage is
 * registered at startup next to the workflow error context storage. Without
 * a registered storage every function is a no-op.
 */
import { processSingleton } from "@/lib/rpc/engine/process-singleton";
import { type RpcEndpoint, RpcOrigin } from "@/lib/rpc/engine/types";

type AttributedEndpoint = Pick<RpcEndpoint, "origin" | "configId">;

/** The part of an engine client the collector needs. */
export type AttributableRpcClient = {
  activeEndpoint(): AttributedEndpoint;
};

type RpcAttributionCollector = {
  /** True once any endpoint served the run. */
  used: boolean;
  /** True once an organization endpoint served the run. */
  servedByOrg: boolean;
  /** The last organization config that served the run. */
  configId: string | null;
  /** True once a call of the run moved from its primary to its fallback. */
  failedOver: boolean;
  parent: RpcAttributionCollector | undefined;
};

export type RpcAttributionStorage = {
  getStore(): RpcAttributionCollector | undefined;
  run<T>(collector: RpcAttributionCollector, fn: () => T): T;
};

/** What a step or direct execution stores about the RPC endpoints it used. */
export type RpcAttribution = {
  rpcOrigin: RpcOrigin;
  rpcConfigId: string | null;
  rpcFailedOver: boolean;
};

const storageSlot = processSingleton<{
  storage: RpcAttributionStorage | null;
}>("rpcAttributionStorage", () => ({ storage: null }));

export function setRpcAttributionStorage(s: RpcAttributionStorage): void {
  storageSlot.storage = s;
}

/**
 * Run `fn` with a fresh collector. A nested run also reports to the runs
 * around it, so a direct execution that dispatches a step sees the step's
 * clients too.
 */
export function runWithRpcAttribution<T>(fn: () => T): T {
  const { storage } = storageSlot;
  if (!storage) {
    return fn();
  }
  const collector: RpcAttributionCollector = {
    used: false,
    servedByOrg: false,
    configId: null,
    failedOver: false,
    parent: storage.getStore(),
  };
  return storage.run(collector, fn);
}

function forEachCollector(
  note: (collector: RpcAttributionCollector) => void
): void {
  let collector = storageSlot.storage?.getStore();
  while (collector) {
    note(collector);
    collector = collector.parent;
  }
}

/** Note that `endpoint` served the current run and every run around it. */
function noteServed(endpoint: AttributedEndpoint): void {
  forEachCollector((collector) => {
    collector.used = true;
    if (endpoint.origin === RpcOrigin.ORG) {
      collector.servedByOrg = true;
      collector.configId = endpoint.configId ?? collector.configId;
    }
  });
}

/** Called by the engine for every client it returns. No-op outside a run. */
export function noteRpcClient(client: AttributableRpcClient): void {
  noteServed(client.activeEndpoint());
}

/*
 * The two below are called from a call's telemetry, in the caller's context,
 * so a manager shared across steps reports each call to the step that made
 * it rather than its own current state.
 */

/** A call of the current run was served by `endpoint`. */
export function noteRpcCall(endpoint: AttributedEndpoint): void {
  noteServed(endpoint);
}

/** A call of the current run moved from its primary to its fallback. */
export function noteRpcFailover(): void {
  forEachCollector((collector) => {
    collector.failedOver = true;
  });
}

/**
 * The stored attribution. Organization origin wins when any of its endpoints
 * served; the config is the last one that did.
 */
function deriveRpcAttribution(
  collector: RpcAttributionCollector
): RpcAttribution | null {
  if (!collector.used) {
    return null;
  }
  return {
    rpcOrigin: collector.servedByOrg ? RpcOrigin.ORG : RpcOrigin.PLATFORM,
    rpcConfigId: collector.servedByOrg ? collector.configId : null,
    rpcFailedOver: collector.failedOver,
  };
}

/** The attribution of the current run so far, null outside a run or with no RPC. */
export function readRpcAttribution(): RpcAttribution | null {
  const collector = storageSlot.storage?.getStore();
  return collector ? deriveRpcAttribution(collector) : null;
}
