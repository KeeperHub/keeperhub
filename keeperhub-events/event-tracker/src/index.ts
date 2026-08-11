import os from "node:os";
import { logger } from "../lib/utils/logger";
import { chainProviderManager } from "./chains/provider-manager";
import {
  type HealthServerHandle,
  startHealthServer,
} from "./health/health-server";
import { shutdownRegistry, synchronizeData } from "./main";

// Fatal-error handlers: an uncaught exception or unhandled rejection inside a
// listener callback is almost always a bug that leaves the process in an
// indeterminate state. Log and exit so K8s restarts the pod. Blast radius is
// the whole pod, which makes these handlers load-bearing.
process.on("uncaughtException", (err: Error) => {
  logger.error(`[Fatal] uncaughtException: ${err.message}\n${err.stack ?? ""}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  logger.error(`[Fatal] unhandledRejection: ${message}\n${stack}`);
  process.exit(1);
});

const initialize = async (): Promise<(signal: string) => Promise<void>> => {
  if (!process.env.INTERNAL_SERVICE_HMAC_SECRET) {
    throw new Error("INTERNAL_SERVICE_HMAC_SECRET is required");
  }
  const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 3001);

  // Health server bind must succeed for K8s probes to work. Kept outside
  // the try/catch below so a bind failure (port taken, EACCES) rejects
  // initialize(), which the unhandledRejection handler turns into
  // exit(1) for K8s restart. A silent bind failure would zombify the
  // pod: process alive, no workflows running, no probe.
  const healthServer: HealthServerHandle = await startHealthServer(
    chainProviderManager,
    HEALTH_PORT,
  );
  logger.log(`[Health] /healthz listening on :${healthServer.port}`);

  await synchronizeData();
  const synchronizeDataInterval = setInterval(synchronizeData, 30_000);

  // Graceful shutdown: K8s sends SIGTERM on pod rotation. The pod owns every
  // listener, so we must stop them here. Best-effort - if stopAll throws we
  // still exit so K8s can restart.
  async function shutdown(signal: string): Promise<void> {
    logger.log(`[Shutdown] received ${signal}; stopping listeners`);
    clearInterval(synchronizeDataInterval);

    await shutdownRegistry().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Shutdown] error during registry shutdown: ${message}`);
    });

    await healthServer.close().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Shutdown] error closing health server: ${message}`);
    });

    process.exit(0);
  }

  return shutdown;
};

// Register signal handlers before initialize() so a signal arriving during
// startup is handled rather than causing a default Node.js exit. Before the
// full shutdown handler is ready, a signal triggers a clean immediate exit
// (nothing to tear down yet). Once initialize() resolves the reference is
// swapped in-place so subsequent signals use the full graceful path.
let onSignal: (signal: string) => void = (signal) => {
  logger.log(`[Shutdown] received ${signal} during startup; exiting`);
  process.exit(0);
};
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
// SIGHUP default is silent termination; alias to graceful shutdown so the
// pod always exits through the logged teardown path.
process.on("SIGHUP", () => onSignal("SIGHUP"));
// SIGUSR1 starts the Node.js inspector. Suppress it: debug attachment requires
// cluster-level access but adds an unnecessary exposure surface for a
// self-hosted deployment where defence-in-depth applies at every layer.
process.on("SIGUSR1", () => {
  logger.warn("[Security] SIGUSR1 received; inspector activation suppressed");
});

logger.log(`Initializing container: ${os.hostname()}`);
void initialize().then((shutdown) => {
  onSignal = (signal) => {
    void shutdown(signal);
  };
  logger.log("Initialization complete.");
});
