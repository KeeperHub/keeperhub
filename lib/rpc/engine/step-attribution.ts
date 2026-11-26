/**
 * Per-step record of which RPC endpoints served a workflow step or a direct
 * execution. The engine notes every client it hands out; the step wrapper
 * reads the note when the step completes.
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
  manager: { isCurrentlyUsingFallback(): boolean };
};

type NotedClient = {
  client: AttributableRpcClient;
  servedAtStart: AttributedEndpoint;
};

type RpcAttributionCollector = {
  clients: NotedClient[];
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
    clients: [],
    parent: storage.getStore(),
  };
  return storage.run(collector, fn);
}

/** Called by the engine for every client it returns. No-op outside a run. */
export function noteRpcClient(client: AttributableRpcClient): void {
  let collector = storageSlot.storage?.getStore();
  if (!collector) {
    return;
  }
  const servedAtStart = client.activeEndpoint();
  while (collector) {
    collector.clients.push({ client, servedAtStart });
    collector = collector.parent;
  }
}

function isOrgEndpoint(endpoint: AttributedEndpoint): boolean {
  return endpoint.origin === RpcOrigin.ORG;
}

/**
 * Derive the stored attribution from the noted clients. Organization origin
 * wins when any of its endpoints served; the config is the last one that did.
 */
function deriveRpcAttribution(
  clients: readonly NotedClient[]
): RpcAttribution | null {
  if (clients.length === 0) {
    return null;
  }
  let configId: string | null = null;
  let servedByOrg = false;
  let failedOver = false;
  for (const { client, servedAtStart } of clients) {
    failedOver = failedOver || client.manager.isCurrentlyUsingFallback();
    for (const served of [servedAtStart, client.activeEndpoint()]) {
      if (isOrgEndpoint(served)) {
        servedByOrg = true;
        configId = served.configId ?? configId;
      }
    }
  }
  return {
    rpcOrigin: servedByOrg ? RpcOrigin.ORG : RpcOrigin.PLATFORM,
    rpcConfigId: servedByOrg ? configId : null,
    rpcFailedOver: failedOver,
  };
}

/** The attribution of the current run so far, null outside a run or with no RPC. */
export function readRpcAttribution(): RpcAttribution | null {
  const collector = storageSlot.storage?.getStore();
  return collector ? deriveRpcAttribution(collector.clients) : null;
}
