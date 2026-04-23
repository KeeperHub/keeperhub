/**
 * Schedule Dispatcher Script
 *
 * Runs continuously and evaluates workflow schedules every minute.
 * Dispatches matching cron expressions to SQS for execution.
 *
 * Usage:
 *   pnpm dispatcher
 *
 * Environment variables:
 *   KEEPERHUB_API_URL - KeeperHub API URL (default: http://localhost:3000)
 *   KEEPERHUB_API_KEY - Service API key for authentication
 *   AWS_ENDPOINT_URL - LocalStack endpoint (default: http://localhost:4566)
 *   SQS_QUEUE_URL - SQS queue URL (default: LocalStack queue)
 *   HEALTH_PORT - Health check server port (default: 3000)
 */

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { CronExpressionParser } from "cron-parser";
import express from "express";
import { sqs } from "../lib/sqs-client.js";
import {
  KEEPERHUB_URL,
  SERVICE_API_KEY,
  SQS_QUEUE_URL,
} from "../lib/config.js";
import type { Schedule, ScheduleMessage } from "../lib/types.js";

/**
 * Fetch enabled schedules from KeeperHub API
 */
async function fetchSchedules(): Promise<Schedule[]> {
  const response = await fetch(`${KEEPERHUB_URL}/api/internal/schedules`, {
    method: "GET",
    headers: {
      "X-Service-Key": SERVICE_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch schedules: ${response.status} ${await response.text()}`
    );
  }

  const data = (await response.json()) as { schedules: Schedule[] };
  return data.schedules;
}

/**
 * Check if a cron expression should trigger at the given time
 */
function shouldTriggerNow(
  cronExpression: string,
  timezone: string,
  now: Date
): boolean {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: now,
      tz: timezone,
    });

    // Get the previous occurrence
    const prev = interval.prev().toDate();

    // Check if the previous occurrence is within the current minute
    const diffMs = now.getTime() - prev.getTime();

    // Within current minute (0-59 seconds)
    return diffMs >= 0 && diffMs < 60_000;
  } catch (error) {
    console.error(`Invalid cron expression: ${cronExpression}`, error);
    return false;
  }
}

/**
 * Send message to SQS queue
 */
async function sendToQueue(message: ScheduleMessage): Promise<void> {
  const command = new SendMessageCommand({
    QueueUrl: SQS_QUEUE_URL,
    MessageBody: JSON.stringify(message),
    MessageAttributes: {
      TriggerType: {
        DataType: "String",
        StringValue: "schedule",
      },
      WorkflowId: {
        DataType: "String",
        StringValue: message.workflowId,
      },
    },
  });

  await sqs.send(command);
}

/**
 * Main dispatch function
 */
async function dispatch(): Promise<{
  evaluated: number;
  triggered: number;
  errors: number;
}> {
  const runId = crypto.randomUUID().slice(0, 8);
  console.log(
    `[${runId}] Starting dispatch run at ${new Date().toISOString()}`
  );

  // Fetch all enabled schedules via API
  const schedules = await fetchSchedules();

  console.log(`[${runId}] Found ${schedules.length} enabled schedules`);

  const now = new Date();
  let triggered = 0;
  let errors = 0;

  for (const schedule of schedules) {
    try {
      const shouldTrigger = shouldTriggerNow(
        schedule.cronExpression,
        schedule.timezone,
        now
      );

      if (shouldTrigger) {
        console.log(
          `[${runId}] Triggering workflow ${schedule.workflowId} ` +
            `(cron: ${schedule.cronExpression}, tz: ${schedule.timezone})`
        );

        await sendToQueue({
          workflowId: schedule.workflowId,
          scheduleId: schedule.id,
          triggerTime: now.toISOString(),
          triggerType: "schedule",
        });

        triggered += 1;
      }
    } catch (error) {
      console.error(
        `[${runId}] Error processing schedule ${schedule.id}:`,
        error
      );
      errors += 1;
    }
  }

  console.log(
    `[${runId}] Dispatch complete: evaluated=${schedules.length}, triggered=${triggered}, errors=${errors}`
  );

  return {
    evaluated: schedules.length,
    triggered,
    errors,
  };
}

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
    error.stack ?? ""
  );
  process.exit(1);
});

// Main entry point
async function main() {
  console.log("[Dispatcher] Starting schedule dispatcher...");
  console.log(`[Dispatcher] KeeperHub URL: ${KEEPERHUB_URL}`);
  console.log(`[Dispatcher] SQS Queue URL: ${SQS_QUEUE_URL}`);

  // Start health check server
  const healthApp = express();
  const HEALTH_PORT = process.env.HEALTH_PORT || 3060;

  healthApp.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      service: "schedule-dispatcher",
      timestamp: new Date().toISOString(),
    });
  });

  const healthServer = healthApp.listen(HEALTH_PORT, () => {
    console.log(
      `[Dispatcher] Health check server listening on port ${HEALTH_PORT}`
    );
  });

  // Close health server on shutdown
  const shutdownHandler = () => {
    console.log("\n[Dispatcher] Shutting down...");
    healthServer.close(() => {
      console.log("[Dispatcher] Health server closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);

  // Run dispatch immediately on startup
  console.log("[Dispatcher] Running initial dispatch...");
  try {
    await dispatch();
  } catch (error) {
    console.error("[Dispatcher] Initial dispatch failed:", error);
  }

  // Then run every minute
  console.log("[Dispatcher] Starting interval (runs every 60 seconds)");
  setInterval(async () => {
    try {
      await dispatch();
    } catch (error) {
      console.error("[Dispatcher] Dispatch failed:", error);
    }
  }, 60_000); // 60 seconds
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Dispatcher] Fatal startup error: ${message}`);
  process.exit(1);
});
