import "server-only";

import {
  fallback,
  HttpRequestError,
  http,
  TimeoutError,
  type Transport,
} from "viem";
import { safeFetch } from "@/lib/safe-fetch";
import { classifyRpcError } from "../providers";
import { redactAllUrls } from "../scrub-rpc-urls";
import type { EvmRpcClient } from "./engine";
import { markOrgRpcError } from "./org-rpc-error";
import { redactOrganizationHosts } from "./organization-hosts";
import { RpcErrorType, RpcOperationType } from "./telemetry/sink";
import { type RpcEndpoint, RpcOrigin, RpcRoutePosition } from "./types";

/** safeFetch label shared with the ethers transport in safe-ethers-fetch. */
const SAFE_FETCH_PLUGIN = "rpc-evm";

const BROADCAST_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
]);

/** How deep a cause chain is cleaned; viem nests a few levels at most. */
const MAX_CAUSE_DEPTH = 8;

const TEXT_FIELDS = ["message", "shortMessage", "details", "stack"] as const;

function safeViemFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return safeFetch(input, { ...init, plugin: SAFE_FETCH_PLUGIN });
}

/**
 * viem writes the request URL into its errors' text, API key included. Strip
 * every URL from the error and its causes before it leaves the transport.
 */
function redacted(text: string): string {
  return redactOrganizationHosts(redactAllUrls(text));
}

function redactViemError(error: unknown, depth = 0): void {
  if (depth >= MAX_CAUSE_DEPTH || typeof error !== "object" || error === null) {
    return;
  }
  const fields = error as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    const value = fields[field];
    if (typeof value === "string") {
      fields[field] = redacted(value);
    }
  }
  if (Array.isArray(fields.metaMessages)) {
    fields.metaMessages = fields.metaMessages.map((line: unknown) =>
      typeof line === "string" ? redacted(line) : line
    );
  }
  if (typeof fields.url === "string") {
    fields.url = redacted(fields.url);
  }
  redactViemError(fields.cause, depth + 1);
}

const HTTP_TOO_MANY_REQUESTS = 429;

function classifyViemError(error: unknown): RpcErrorType {
  if (error instanceof TimeoutError) {
    return RpcErrorType.TIMEOUT;
  }
  if (error instanceof HttpRequestError) {
    return error.status === HTTP_TOO_MANY_REQUESTS
      ? RpcErrorType.RATE_LIMIT
      : RpcErrorType.CONNECTION;
  }
  return classifyRpcError(error);
}

function endpointTransport(
  client: EvmRpcClient,
  endpoint: RpcEndpoint,
  position: RpcRoutePosition
): Transport {
  const base = http(endpoint.url.reveal(), { fetchFn: safeViemFetch });
  const { telemetry } = client;
  return (config) => {
    const transport = base(config);
    type Request = typeof transport.request;
    const call = async (
      args: Parameters<Request>[0],
      options?: Parameters<Request>[1]
    ): Promise<unknown> => {
      const operation = BROADCAST_METHODS.has(args.method)
        ? RpcOperationType.WRITE_BROADCAST
        : RpcOperationType.READ;
      telemetry.attempt(position, operation);
      const startedAt = performance.now();
      try {
        const result = await transport.request(args, options);
        telemetry.latency(position, performance.now() - startedAt, operation);
        telemetry.success(position, operation);
        return result;
      } catch (error) {
        telemetry.latency(position, performance.now() - startedAt, operation);
        telemetry.failure(position, operation);
        telemetry.errorType(position, classifyViemError(error), operation);
        redactViemError(error);
        if (endpoint.origin === RpcOrigin.ORG && typeof error === "object") {
          markOrgRpcError(error as object);
        }
        throw error;
      }
    };
    // The wrapper returns whatever the inner request does, so its typing holds.
    return { ...transport, request: call as Request };
  };
}

/**
 * One viem transport per endpoint of the client's route, the endpoint
 * currently serving calls first. For code that must try endpoints one by
 * one, like a receipt poll that rotates on a wedged node. Calls are counted
 * like the client's own, and their errors carry no URL.
 */
export function viemTransportsOf(client: EvmRpcClient): Transport[] {
  const { primary, fallback: fallbackEndpoint } = client.route;
  const positioned: [RpcEndpoint, RpcRoutePosition][] = [
    [primary, RpcRoutePosition.PRIMARY],
  ];
  if (fallbackEndpoint) {
    positioned.push([fallbackEndpoint, RpcRoutePosition.FALLBACK]);
  }
  const active = client.activeEndpoint();
  const ordered = [
    ...positioned.filter(([endpoint]) => endpoint === active),
    ...positioned.filter(([endpoint]) => endpoint !== active),
  ];
  return ordered.map(([endpoint, position]) =>
    endpointTransport(client, endpoint, position)
  );
}

/** A viem transport over the client's route, failing over like the manager. */
export function viemTransportOf(client: EvmRpcClient): Transport {
  return fallback(viemTransportsOf(client));
}
