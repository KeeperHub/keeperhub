import "server-only";

import { logWarn } from "@/lib/logging";
import { RpcRouteError, RpcRouteErrorCode } from "./route-error";
import { getRpcEngine } from "./runtime";
import {
  parseRpcSelection,
  RPC_SELECTION_CONFIG_KEY,
  rpcScopeForOrganization,
} from "./scope";
import { isPlatformOnlyRoute } from "./telemetry/route-sink";
import {
  type RpcEndpoint,
  type RpcOrigin,
  RpcPurpose,
  type RpcRoute,
  type RpcTransport,
} from "./types";

const NETWORK_CONFIG_KEY = "network";

/**
 * Refusals that come from the organization's own settings. A trigger hit by
 * one must not fall back to KeeperHub's endpoints, so it is not listened to.
 * Anything else (unknown chain, no WebSocket on the chain) keeps today's
 * handling in the services.
 */
const ORG_SETTING_REFUSALS: ReadonlySet<RpcRouteErrorCode> = new Set([
  RpcRouteErrorCode.NOT_COVERED,
  RpcRouteErrorCode.PLATFORM_FORBIDDEN,
  RpcRouteErrorCode.CONFIG_NOT_FOUND,
  RpcRouteErrorCode.CONFIG_DISABLED,
  RpcRouteErrorCode.CONFIG_CHAIN_MISMATCH,
]);

/** One endpoint of a trigger route, as the trigger services receive it. */
export type TriggerRouteEndpoint = {
  url: string;
  origin: RpcOrigin;
  configId: string | null;
};

/**
 * The endpoints a trigger listens on when its organization's route differs
 * from KeeperHub's. Services key their sockets by `key` and attribute usage
 * to the endpoint that served it.
 */
export type TriggerRpcRoute = {
  key: string;
  organizationId: string;
  chainId: number;
  transport: RpcTransport;
  primary: TriggerRouteEndpoint;
  fallback?: TriggerRouteEndpoint;
};

type TriggerNode = {
  data?: { config?: Record<string, unknown> };
};

export type TriggerWorkflow = {
  id: string;
  organizationId: string | null;
  nodes: TriggerNode[];
};

/** The chain id a trigger node targets, or null if absent or not numeric. */
export function triggerChainId(node: TriggerNode | undefined): number | null {
  const raw = node?.data?.config?.[NETWORK_CONFIG_KEY];
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const chainId = Number(raw);
  return Number.isFinite(chainId) ? chainId : null;
}

function toEndpoint(endpoint: RpcEndpoint): TriggerRouteEndpoint {
  return {
    url: endpoint.url.reveal(),
    origin: endpoint.origin,
    configId: endpoint.configId,
  };
}

function toTriggerRoute(
  route: RpcRoute,
  organizationId: string
): TriggerRpcRoute {
  return {
    key: route.key,
    organizationId,
    chainId: route.chain.chainId,
    transport: route.transport,
    primary: toEndpoint(route.primary),
    fallback: route.fallback ? toEndpoint(route.fallback) : undefined,
  };
}

type RoutedWorkflow<T> = T & { rpcRoute?: TriggerRpcRoute };

async function routeOne<T extends TriggerWorkflow>(
  workflow: T
): Promise<RoutedWorkflow<T> | null> {
  const node = workflow.nodes[0];
  const chainId = triggerChainId(node);
  if (!workflow.organizationId || chainId === null) {
    return workflow;
  }
  const scope = rpcScopeForOrganization(
    workflow.organizationId,
    parseRpcSelection(node?.data?.config?.[RPC_SELECTION_CONFIG_KEY])
  );
  let route: RpcRoute;
  try {
    route = await getRpcEngine().route(scope, chainId, {
      purpose: RpcPurpose.SUBSCRIBE,
    });
  } catch (error) {
    if (!(error instanceof RpcRouteError)) {
      throw error;
    }
    if (!ORG_SETTING_REFUSALS.has(error.code)) {
      return workflow;
    }
    logWarn("[Trigger Routes] Trigger has no RPC route; not listening", {
      workflow_id: workflow.id,
      chain_id: String(chainId),
      code: error.code,
    });
    return null;
  }
  return isPlatformOnlyRoute(route)
    ? workflow
    : { ...workflow, rpcRoute: toTriggerRoute(route, workflow.organizationId) };
}

/**
 * Give each trigger workflow its route. A workflow on KeeperHub's endpoints
 * is returned as is, so the services keep their shared per-chain sockets for
 * it. One its organization's settings refuse, such as "own RPC only" with
 * no WebSocket endpoint, is left out so nothing listens through KeeperHub
 * on its behalf.
 */
export async function attachTriggerRoutes<T extends TriggerWorkflow>(
  workflows: readonly T[]
): Promise<RoutedWorkflow<T>[]> {
  const routed: (RoutedWorkflow<T> | null)[] = await Promise.all(
    workflows.map((workflow) => routeOne(workflow))
  );
  const kept: RoutedWorkflow<T>[] = [];
  for (const workflow of routed) {
    if (workflow) {
      kept.push(workflow);
    }
  }
  return kept;
}
