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
 *     reports `connected: true`, OR when no chains have been registered
 *     yet (process is still starting up; nothing is "down").
 *   - 503 `{ status: "degraded", chains: [...] }` when any chain is
 *     reconnecting or has no provider.
 *   - 404 for any path other than `/healthz`.
 */

export interface HealthResponseBody {
  status: "ok" | "degraded";
  chains: ReturnType<ChainProviderManager["getAllHealth"]>;
}

export function buildHealthResponse(providerManager: ChainProviderManager): {
  status: 200 | 503;
  body: HealthResponseBody;
} {
  const chains = providerManager.getAllHealth();
  const allHealthy = chains.length === 0 || chains.every((c) => c.connected);
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
