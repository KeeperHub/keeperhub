/**
 * Schedule Dispatcher Script
 *
 * Runs continuously and evaluates workflow schedules on aligned minute
 * boundaries. Dispatches matching cron expressions to SQS for execution.
 *
 * Usage:
 *   pnpm dispatcher
 *
 * Environment variables:
 *   KEEPERHUB_API_URL - KeeperHub API URL (default: http://localhost:3000)
 *   INTERNAL_SERVICE_HMAC_SECRET - HMAC signing secret for internal service auth
 *   AWS_ENDPOINT_URL  - LocalStack endpoint (default: http://localhost:4566)
 *   SQS_QUEUE_URL     - SQS queue URL (default: LocalStack queue)
 *   HEALTH_PORT       - Health check server port (default: 3060)
 *   TICK_OFFSET_MS    - Milliseconds past the minute boundary to fire
 *                       (default: 2000). Cron occurrences land at :00;
 *                       firing at :02 guarantees they are always in the past
 *                       and still well within the 5-second SLA.
 */

// Normalize all console.* output in this process to canonical JSON. Must be
// the first import so the patch installs before any module logs.
import "../log-facade.js";
import express from "express";
import { KEEPERHUB_URL, SQS_QUEUE_URL } from "../lib/config.js";
import {
  type LeaderElectionHandle,
  runWithLeaderElection,
} from "../lib/leader-election.js";
import { dispatch } from "./dispatch.js";
import { registry } from "./metrics.js";

// Log and swallow detached promise rejections so transient failures do not
// crash the dispatcher (Node v15+ exits on unhandled rejection by default).
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : "";
  console.error(`[Dispatcher] Unhandled rejection: ${message}`, stack);
});

// Uncaught sync exceptions indicate corrupted state; log and exit so the
// orchestrator restarts us cleanly rather than continuing in an unknown state.
process.on("uncaughtException", (error: Error) => {
  console.error(
    `[Dispatcher] Uncaught exception: ${error.message}`,
    error.stack ?? "",
  );
  process.exit(1);
});

// How far past the minute boundary (:00) each tick fires. 2 s ensures cron
// occurrences (which land at :00) are always comfortably in the past without
// pushing the trigger time close to the 5-second SLA ceiling.
const TICK_OFFSET_MS = Number(process.env.TICK_OFFSET_MS ?? 2_000);

/**
 * Returns the number of milliseconds until the next tick target:
 * the start of the next wall-clock minute plus TICK_OFFSET_MS.
 *
 * Example: if now is 09:00:42.500 and TICK_OFFSET_MS=2000 the next target
 * is 09:01:02.000, so this returns ~19_500 ms.
 */
function msUntilNextTick(): number {
  const msIntoMinute = Date.now() % 60_000;
  if (msIntoMinute < TICK_OFFSET_MS) {
    // Still early in the current minute — fire at TICK_OFFSET_MS of this minute.
    return TICK_OFFSET_MS - msIntoMinute;
  }
  // Past the target for this minute — wait to the same offset in the next minute.
  return 60_000 - msIntoMinute + TICK_OFFSET_MS;
}

/**
 * Drives the aligned minute-boundary dispatch loop, but only while this
 * instance is the leader. `start()` is called on acquiring leadership and
 * `stop()` on losing it, so a standby holds an idle ticker and never dispatches.
 */
class ScheduleTicker {
  // lastTickAt tracks the `now` of the previous pass so each tick's window
  // covers exactly (lastTickAt, now] — no gaps, no double-fires. It resets to
  // null when leadership (re)starts, so the first pass uses a synthetic
  // (now - 60s, now] window and recovers any occurrence missed during handover.
  private lastTickAt: Date | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly isLeader: () => boolean) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.lastTickAt = null;
    console.log("[Dispatcher] Became leader — running initial dispatch...");
    void this.runOnce(null).then(() => this.scheduleNext());
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log("[Dispatcher] Stopped dispatching (no longer leader)");
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    const delay = msUntilNextTick();
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const prevTick = this.lastTickAt;
    this.lastTickAt = new Date();
    await this.runOnce(prevTick);
    this.scheduleNext();
  }

  private async runOnce(prevTick: Date | null): Promise<void> {
    // Defense in depth: a timer may fire in the narrow window between losing
    // leadership and stop() landing. Never dispatch unless we still hold it.
    if (!this.isLeader()) {
      console.warn("[Dispatcher] Skipping dispatch: not leader");
      return;
    }
    try {
      await dispatch(prevTick);
    } catch (error) {
      console.error("[Dispatcher] Dispatch failed:", error);
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.INTERNAL_SERVICE_HMAC_SECRET) {
    throw new Error("INTERNAL_SERVICE_HMAC_SECRET is required");
  }
  console.log("[Dispatcher] Starting schedule dispatcher...");
  console.log(`[Dispatcher] KeeperHub URL: ${KEEPERHUB_URL}`);
  console.log(`[Dispatcher] SQS Queue URL: ${SQS_QUEUE_URL}`);
  console.log(
    `[Dispatcher] Tick offset: ${TICK_OFFSET_MS}ms past minute boundary`,
  );

  // Gate dispatching on leadership: with 2 replicas only the elected leader may
  // dispatch, otherwise every schedule fires once per replica. `leading` lets
  // the ticker double-check leadership before a queued tick actually dispatches.
  let leading = false;
  const ticker = new ScheduleTicker(() => leading);

  const election: LeaderElectionHandle = runWithLeaderElection({
    leaseName: process.env.LEASE_NAME ?? "schedule-dispatcher-leader",
    onStartedLeading: () => {
      leading = true;
      ticker.start();
    },
    onStoppedLeading: () => {
      leading = false;
      ticker.stop();
    },
  });

  const healthApp = express();
  const HEALTH_PORT = process.env.HEALTH_PORT || 3060;

  healthApp.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "schedule-dispatcher",
      leader: election.isLeader(),
      timestamp: new Date().toISOString(),
    });
  });

  healthApp.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).send(`Error collecting metrics: ${message}`);
    }
  });

  const healthServer = healthApp.listen(HEALTH_PORT, () => {
    console.log(
      `[Dispatcher] Health/metrics server listening on port ${HEALTH_PORT}`,
    );
  });

  let shuttingDown = false;
  const shutdownHandler = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("\n[Dispatcher] Shutting down...");
    ticker.stop();
    // Release the lease so a standby takes over promptly, then close.
    void election
      .stop()
      .catch(() => {
        // best-effort; the lease expires on its own if release fails
      })
      .finally(() => {
        healthServer.close(() => {
          console.log("[Dispatcher] Health server closed");
          process.exit(0);
        });
      });
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGHUP", shutdownHandler);
  process.on("SIGUSR1", () => {
    console.warn(
      "[Security] SIGUSR1 received; inspector activation suppressed",
    );
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Dispatcher] Fatal startup error: ${message}`);
  process.exit(1);
});
