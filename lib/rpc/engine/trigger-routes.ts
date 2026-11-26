import "server-only";

import { logWarn } from "@/lib/logging";
import { resolveEndpointAddresses } from "./public-endpoint";
import { ORG_SETTING_ROUTE_ERRORS, RpcRouteError } from "./route-error";
import { getRpcEngine } from "./runtime";
import {
  parseRpcSelection,
  RPC_SELECTION_CONFIG_KEY,
  rpcScopeForOrganization,
} from "./scope";
import { isPlatformOnlyRoute } from "./telemetry/route-sink";
import {
  type RpcEndpoint,
  RpcOrigin,
  RpcPurpose,
  type RpcRoute,
  type RpcTransport,
} from "./types";

const NETWORK_CONFIG_KEY = "network";

/** One endpoint of a trigger route, as the trigger services receive it. */
export type TriggerRouteEndpoint = {
  url: string;
  origin: RpcOrigin;
  configId: string | null;
  /**
   * Set on an organization's endpoints: the public addresses its host
   * resolved to here. Services connect only to these, so the host cannot be
   * re-pointed at an internal address after the check.
   */
  addresses?: string[];
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

/**
 * An endpoint as a service receives it. An organization's endpoint carries
 * its vetted addresses, or is null when its host is not public right now.
 */
async function toEndpoint(
  endpoint: RpcEndpoint
): Promise<TriggerRouteEndpoint | null> {
  const url = endpoint.url.reveal();
  const sent = { url, origin: endpoint.origin, configId: endpoint.configId };
  if (endpoint.origin !== RpcOrigin.ORG) {
    return sent;
  }
  try {
    return { ...sent, addresses: await resolveEndpointAddresses(url) };
  } catch {
    return null;
  }
}

/** Null when none of the route's endpoints can be handed out. */
async function toTriggerRoute(
  route: RpcRoute,
  organizationId: string
): Promise<TriggerRpcRoute | null> {
  const [primary, fallback] = await Promise.all([
    toEndpoint(route.primary),
    route.fallback ? toEndpoint(route.fallback) : null,
  ]);
  const first = primary ?? fallback;
  if (!first) {
    return null;
  }
  return {
    key: route.key,
    organizationId,
    chainId: route.chain.chainId,
    transport: route.transport,
    primary: first,
    fallback: primary ? (fallback ?? undefined) : undefined,
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
    if (!ORG_SETTING_ROUTE_ERRORS.has(error.code)) {
      return workflow;
    }
    logWarn("[Trigger Routes] Trigger has no RPC route; not listening", {
      workflow_id: workflow.id,
      chain_id: String(chainId),
      code: error.code,
    });
    return null;
  }
  if (isPlatformOnlyRoute(route)) {
    return workflow;
  }
  const rpcRoute = await toTriggerRoute(route, workflow.organizationId);
  if (!rpcRoute) {
    logWarn(
      "[Trigger Routes] Trigger's RPC endpoints are not public; not listening",
      {
        workflow_id: workflow.id,
        chain_id: String(chainId),
      }
    );
    return null;
  }
  return { ...workflow, rpcRoute };
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
