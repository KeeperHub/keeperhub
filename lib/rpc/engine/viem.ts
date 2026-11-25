import "server-only";

import { fallback, http, type Transport } from "viem";
import { safeFetch } from "@/lib/safe-fetch";
import type { EvmRpcClient } from "./engine";
import type { RpcEndpoint } from "./types";

/** safeFetch label shared with the ethers transport in safe-ethers-fetch. */
const SAFE_FETCH_PLUGIN = "rpc-evm";

function safeViemFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return safeFetch(input, { ...init, plugin: SAFE_FETCH_PLUGIN });
}

function endpointTransport(endpoint: RpcEndpoint): Transport {
  return http(endpoint.url.reveal(), { fetchFn: safeViemFetch });
}

/**
 * One viem transport per endpoint of the client's route, the endpoint
 * currently serving calls first. For code that must try endpoints one by
 * one, like a receipt poll that rotates on a wedged node.
 */
export function viemTransportsOf(client: EvmRpcClient): Transport[] {
  const active = client.activeEndpoint();
  const endpoints = [client.route.primary, client.route.fallback].filter(
    (endpoint): endpoint is RpcEndpoint => endpoint !== undefined
  );
  const ordered = [
    active,
    ...endpoints.filter((endpoint) => endpoint !== active),
  ];
  return ordered.map(endpointTransport);
}

/** A viem transport over the client's route, failing over like the manager. */
export function viemTransportOf(client: EvmRpcClient): Transport {
  return fallback(viemTransportsOf(client));
}
