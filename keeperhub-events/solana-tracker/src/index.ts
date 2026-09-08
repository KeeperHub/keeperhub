import os from "node:os";
import { logger } from "../lib/utils/logger";
import {
  type HealthServerHandle,
  startHealthServer,
} from "./health/health-server";
import { getAllHealth, shutdownAll, synchronizeData } from "./main";

// Fatal-error handlers: an uncaught exception or unhandled rejection is almost
// always a bug that leaves the process indeterminate. Log and exit so K8s
// restarts the pod.
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

  const healthServer: HealthServerHandle = await startHealthServer(
    getAllHealth,
    HEALTH_PORT,
  );
  logger.log(`[Health] /healthz listening on :${healthServer.port}`);

  await synchronizeData();
  const interval = setInterval(synchronizeData, 30_000);

  async function shutdown(signal: string): Promise<void> {
    logger.log(`[Shutdown] received ${signal}; stopping ingestors`);
    clearInterval(interval);
    await shutdownAll().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Shutdown] error during ingestor shutdown: ${message}`);
    });
    await healthServer.close().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Shutdown] error closing health server: ${message}`);
    });
    process.exit(0);
  }

  return shutdown;
};

let onSignal: (signal: string) => void = (signal) => {
  logger.log(`[Shutdown] received ${signal} during startup; exiting`);
  process.exit(0);
};
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGHUP", () => onSignal("SIGHUP"));
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
