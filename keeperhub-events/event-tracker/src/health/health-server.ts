import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { ChainProviderManager } from "../chains/provider-manager";

/**
 * HTTP `/healthz` endpoint backed by ChainProviderManager.
 *
 * Semantics:
 *   - 200 `{ status: "ok", chains: [...] }` when every registered chain
 *     reports `connected: true` and none has paused trace matching, OR when
 *     no chains have been registered yet (process is still starting up;
 *     nothing is "down").
 *   - 503 `{ status: "degraded", chains: [...] }` when any chain is
 *     reconnecting, has no provider, or is carrying trace subscribers on a
 *     connection that refused `debug_traceBlockByNumber`.
 *   - 404 for any path other than `/healthz`.
 */

export interface HealthResponseBody {
  status: "ok" | "degraded";
  chains: ReturnType<ChainProviderManager["getAllHealth"]>;
}

/**
 * A chain that is connected but has stopped matching traces.
 *
 * `connected` is transport health, and on its own it reported a fully green
 * pod for a chain whose trace triggers had silently stopped: a refusal sets
 * `traceUnsupported`, logs once, reports the range served so the shared
 * high-water mark keeps advancing, and stops asking until reconnect. The flag
 * reached this payload but nothing computed from it, so every consumer that
 * watches the status code rather than reading each chain object saw ok.
 *
 * Gated on `traceSubscriberCount` because the flag outlives the last
 * unsubscribe: a chain with no trace work left is not degraded by a
 * capability it no longer needs.
 *
 * This is not the common case any more. `workflow-mapper.ts` refuses a Trace
 * registration on a chain that is not known to answer the method, so reaching
 * this state means an upstream we had reason to believe capable is not -- an
 * unexpected condition, and worth the same 503 a transport drop gets.
 *
 * Failing this endpoint does not restart anything: the deployed liveness and
 * readiness probes are `pgrep` exec probes
 * (`deploy/event-tracker/{staging,prod}/values.yaml`), so `/healthz` is a
 * monitoring and alerting signal rather than a restart trigger.
 */
function traceMatchingPaused(
  chain: HealthResponseBody["chains"][number],
): boolean {
  return chain.traceSubscriberCount > 0 && chain.traceUnsupported;
}

export function buildHealthResponse(providerManager: ChainProviderManager): {
  status: 200 | 503;
  body: HealthResponseBody;
} {
  const chains = providerManager.getAllHealth();
  const allHealthy =
    chains.length === 0 ||
    chains.every((c) => c.connected && !traceMatchingPaused(c));
  return {
    status: allHealthy ? 200 : 503,
    body: { status: allHealthy ? "ok" : "degraded", chains },
  };
}

export function createHealthRequestHandler(
  providerManager: ChainProviderManager,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0];
    if (pathOnly !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const { status, body } = buildHealthResponse(providerManager);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

export interface HealthServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startHealthServer(
  providerManager: ChainProviderManager,
  port: number,
): Promise<HealthServerHandle> {
  const server = createServer(createHealthRequestHandler(providerManager));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
