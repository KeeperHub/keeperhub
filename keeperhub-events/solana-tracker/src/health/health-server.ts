import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { ConnectionHealth } from "../ingest/solana-connection";

/**
 * HTTP `/healthz` backed by the ingestor registry. 200 when every chain's slot
 * subscription is connected (or none are registered yet); 503 when any chain is
 * reconnecting / has no live subscription.
 */

export interface HealthResponseBody {
  status: "ok" | "degraded";
  chains: ConnectionHealth[];
}

export function buildHealthResponse(chains: ConnectionHealth[]): {
  status: 200 | 503;
  body: HealthResponseBody;
} {
  const allHealthy = chains.length === 0 || chains.every((c) => c.connected);
  return {
    status: allHealthy ? 200 : 503,
    body: { status: allHealthy ? "ok" : "degraded", chains },
  };
}

export function createHealthRequestHandler(
  getHealth: () => ConnectionHealth[],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const pathOnly = (req.url ?? "").split("?")[0];
    if (pathOnly !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const { status, body } = buildHealthResponse(getHealth());
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
  getHealth: () => ConnectionHealth[],
  port: number,
): Promise<HealthServerHandle> {
  const server = createServer(createHealthRequestHandler(getHealth));
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
