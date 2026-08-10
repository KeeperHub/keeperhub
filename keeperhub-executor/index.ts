/**
 * Unified Workflow Executor
 *
 * Polls a single SQS queue for all trigger types (schedule, block, event)
 * and executes workflows either in isolated K8s Jobs or in-process,
 * depending on whether the workflow contains web3 write actions.
 *
 * Usage:
 *   tsx keeperhub-executor/index.ts
 *
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string
 *   SQS_QUEUE_URL - SQS queue URL (single queue for all trigger types)
 *   AWS_REGION - AWS region (default: us-east-1)
 *   AWS_ENDPOINT_URL - LocalStack endpoint (local dev only)
 *   RUNNER_IMAGE - Docker image for K8s Job workflow runner
 *   K8S_NAMESPACE - Kubernetes namespace for Jobs
 *   INTEGRATION_ENCRYPTION_KEY - Key for decrypting credentials
 *   HEALTH_PORT - Health check server port (default: 3080)
 *   JOB_TTL_SECONDS - Time to keep completed K8s Jobs (default: 3600)
 *   JOB_ACTIVE_DEADLINE - Max Job execution time in seconds (default: 300)
 */

// Normalize all console.* output in this process to canonical JSON. Must be
// the first import so the patch installs before any module logs.
import "./log-facade";
import { createServer, type IncomingMessage } from "node:http";
import {
  DeleteMessageCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "../lib/db/schema";
import { getMetricsCollector } from "../lib/metrics";
import { LabelKeys, MetricNames } from "../lib/metrics/types";
import { withBackstopCapture } from "../lib/security/backstop-capture";
import { buildAttribution } from "../lib/security/request-attribution";
import { verifySqsMessageSignature } from "../lib/sqs-message-auth";
import { generateId } from "../lib/utils/id";
import { checkConcurrencyLimit } from "../lib/workflow/concurrency";
import { hashWorkflowDefinition } from "../lib/workflow/content-hash";
import { loadWorkflowForExecution } from "../lib/workflow/load-for-execution";
import type { WorkflowNode } from "../lib/workflow/store";
import { chargePaygExecution } from "../lib/billing/payg/charge";
import { PAYG_OVERFLOW_REASON } from "../lib/billing/payg/constants";
import { type ApiExecuteTriggerType, executeViaApi } from "./api-execute";
import { checkExecutionLimitForExecutor } from "./billing-guard";
import { CONFIG } from "./config";
import { resolveDispatchTarget } from "./execution-mode";
import { checkWorkflowFeaturesForExecutor } from "./feature-guard";
import { executeInProcess } from "./in-process";
import { createWorkflowJob } from "./k8s-job";
import {
  claimPendingForExecution,
  claimPhantomForExecution,
  discardPhantomRow,
  failExecutionAsSystemError,
  resolvePhantomToError,
} from "./lib/db-helpers";
import { applyCounterDeltas, isIngestPayload } from "./lib/metrics-shipping";
import { toJsonSafe } from "./lib/serialize";
import { executorMessageSchema } from "./message-schema";
import {
  assertHmacSecretSet,
  assertTurnkeyEnvForActiveWallets,
} from "./startup-checks";
import type { ExecutorMessage, ScheduleMessage } from "./types";

const INGEST_MAX_BODY_BYTES = 256 * 1024;

/**
 * KEEP-853: a deliberate "leave the message on the queue and retry later"
 * signal, distinct from a genuine processing failure. Thrown when the executor
 * is at capacity (concurrency cap) so processMessage skips the system-error
 * backstop and lets SQS redeliver the message after the visibility timeout.
 */
export class RequeueSignal extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > INGEST_MAX_BODY_BYTES) {
      throw new Error("Ingest payload too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw);
}

// Database
const queryClient = postgres(CONFIG.databaseUrl, {
  connect_timeout: 10,
  idle_timeout: 30,
  max_lifetime: 60 * 5,
  connection: { statement_timeout: 30_000 },
});
const db = drizzle(queryClient, {
  schema: { workflows, workflowExecutions, workflowSchedules },
});

/**
 * Settle the PAYG per-execution charge for a free-tier org that has passed its
 * included limit. Called AFTER the pending/phantom row is claimed, so the same
 * atomic claim that dedupes duplicate SQS deliveries also single-flights the
 * charge (no concurrent double-settle). Returns true to proceed, or false after
 * resolving the claimed row to a user-facing billing error so the run stops.
 */
async function settlePaygOverflow(params: {
  workflowId: string;
  triggerType: string;
  organizationId: string;
  executionId: string;
  claimedStatus: "pending" | "running";
}): Promise<boolean> {
  const charge = await chargePaygExecution({
    organizationId: params.organizationId,
    executionId: params.executionId,
  });
  if (charge.ok) {
    return true;
  }
  console.warn(
    `[Executor] PAYG charge blocked ${params.triggerType} trigger for workflow ${params.workflowId}: org=${params.organizationId} reason=${charge.reason}`
  );
  if (params.claimedStatus === "running") {
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: charge.message,
        errorCategory: "billing",
        errorType: "user",
        // Unpaid means the run never started, so it consumes no quota.
        billable: false,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(workflowExecutions.id, params.executionId),
          eq(workflowExecutions.status, "running")
        )
      );
  } else {
    await resolvePhantomToError(db, params.executionId, {
      error: charge.message,
      errorCategory: "billing",
      errorType: "user",
    });
  }
  return false;
}

// SQS
const sqsConfig: ConstructorParameters<typeof SQSClient>[0] = {
  region: CONFIG.awsRegion,
};

if (CONFIG.awsEndpoint) {
  sqsConfig.endpoint = CONFIG.awsEndpoint;
  sqsConfig.credentials = {
    accessKeyId: CONFIG.awsAccessKeyId,
    secretAccessKey: CONFIG.awsSecretAccessKey,
  };
}

const sqs = new SQSClient(sqsConfig);

function buildInput(message: ExecutorMessage): Record<string, unknown> {
  switch (message.triggerType) {
    case "schedule":
      return {
        triggerType: "schedule",
        scheduleId: message.scheduleId,
        triggerTime: message.triggerTime,
      };
    case "block":
      return {
        triggerType: "block",
        ...message.triggerData,
      };
    case "event":
      return {
        triggerType: "event",
        ...message.triggerData,
      };
    case "manual":
      return { triggerType: "manual" as const, ...message.input };
    case "webhook":
      return { triggerType: "webhook" as const, ...message.input };
    default: {
      const _exhaustive: never = message;
      throw new Error(
        `Unknown trigger type: ${(_exhaustive as ExecutorMessage).triggerType}`
      );
    }
  }
}

async function validateSchedule(scheduleId: string): Promise<boolean> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    console.error(`[Executor] Schedule not found: ${scheduleId}`);
    return false;
  }

  if (!schedule.enabled) {
    console.log(`[Executor] Schedule disabled, skipping: ${scheduleId}`);
    return false;
  }

  return true;
}

function getScheduleId(message: ExecutorMessage): string | undefined {
  return message.triggerType === "schedule" ? message.scheduleId : undefined;
}

async function dispatchExecution(params: {
  target: string;
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType: ApiExecuteTriggerType;
  scheduleId?: string;
}): Promise<void> {
  const { target, workflowId, executionId, input, triggerType, scheduleId } =
    params;

  switch (target) {
    case "k8s-job": {
      try {
        const job = await createWorkflowJob({
          workflowId,
          executionId,
          input,
          triggerType,
          scheduleId,
        });

        console.log(
          `[Executor] Created K8s Job: ${job.metadata?.name} for execution ${executionId}`
        );
      } catch (error) {
        console.error("[Executor] Failed to create K8s Job:", error);

        await db
          .update(workflowExecutions)
          .set({
            status: "system_error",
            error:
              error instanceof Error
                ? `Failed to create job: ${error.message}`
                : "Failed to create job",
            errorCode: "P-0002",
            errorType: "system",
            errorCategory: "infrastructure",
            completedAt: new Date(),
          })
          .where(eq(workflowExecutions.id, executionId));

        throw error;
      }
      break;
    }
    case "api": {
      await executeViaApi({ workflowId, executionId, input, triggerType });
      break;
    }
    case "in-process": {
      await executeInProcess({
        workflowId,
        executionId,
        input,
        triggerType,
        scheduleId,
        db,
      });
      break;
    }
    default:
      throw new Error(`Unknown dispatch target: ${target}`);
  }
}

type ConsumeClaimResult =
  | "claimed"
  | "dropped_advanced"
  | "dropped_missing"
  | "idless_insert";

function recordConsumeClaim(
  result: ConsumeClaimResult,
  triggerType: string
): void {
  getMetricsCollector().incrementCounter(MetricNames.SQS_CONSUME_CLAIM, {
    [LabelKeys.CLAIM_RESULT]: result,
    [LabelKeys.TRIGGER_TYPE]: triggerType,
  });
}

// A claim that did not win is a duplicate delivery (its row already ran/advanced
// or is gone): record the outcome and warn. The caller returns so processMessage
// deletes the message and it stops redelivering.
function dropDuplicateDelivery(
  claim: "already_advanced" | "not_found",
  triggerType: string,
  executionId: string | undefined
): void {
  recordConsumeClaim(
    claim === "already_advanced" ? "dropped_advanced" : "dropped_missing",
    triggerType
  );
  console.warn(
    `[Executor] Duplicate ${triggerType} delivery (${claim}) for execution ${executionId}; dropping without re-running`
  );
}

async function processExecutorMessage(message: ExecutorMessage): Promise<void> {
  const { workflowId, triggerType } = message;

  console.log(
    `[Executor] Processing ${triggerType} trigger for workflow ${workflowId}`
  );

  // Load the workflow and evaluate its lifecycle state in one round-trip.
  // A soft-deleted or deactivated workflow - or one whose owning org is
  // deactivated - must never execute, even if a stale schedule or queued
  // message still references it. The block_executions DB trigger is the
  // INSERT-time backstop; this skips the work before it gets that far. The org
  // owns the workflow, so org deactivation is the owner gate.
  //
  // Manual runs are the exception: the editor "Run" button must work on
  // not-yet-enabled drafts, so manual triggers pass requireEnabled: false to
  // match the interactive execute route. That only bypasses the "disabled"
  // reason - deleted/deactivated/org-deactivated still block - so it stays safe.
  // Automated triggers (schedule/event/block/webhook) keep the enabled gate.
  const loaded = await loadWorkflowForExecution(workflowId, {
    requireEnabled: triggerType !== "manual",
  });
  if (loaded.status === "not_found") {
    console.error(`[Executor] Workflow not found: ${workflowId}`);
    await discardPhantomRow(db, message.executionId);
    return;
  }
  if (loaded.status === "not_executable") {
    console.log(
      `[Executor] Workflow not executable (${loaded.reason}), skipping: ${workflowId}`
    );
    await discardPhantomRow(db, message.executionId);
    return;
  }
  const { workflow } = loaded;

  if (triggerType === "schedule") {
    const valid = await validateSchedule(
      (message as ScheduleMessage).scheduleId
    );
    if (!valid) {
      await discardPhantomRow(db, message.executionId);
      return;
    }
  }

  const billingResult = await checkExecutionLimitForExecutor(
    db,
    workflow.organizationId
  );
  if (!billingResult.allowed) {
    console.warn(
      `[Executor] Billing guard blocked ${triggerType} trigger for workflow ${workflowId}: org=${workflow.organizationId} plan=${billingResult.plan} used=${billingResult.used} limit=${billingResult.limit} effectiveLimit=${billingResult.effectiveLimit} debt=${billingResult.debtExecutions} reason=${billingResult.reason}`
    );
    // KEEP-693: resolve a pre-created phantom to a user-actionable billing
    // error so it surfaces correctly instead of being aged to a system P-code.
    // No phantom -> keep the prior silent-skip behaviour.
    await resolvePhantomToError(db, message.executionId, {
      error:
        "Execution skipped: your plan's monthly execution limit has been reached.",
      errorCategory: "billing",
      errorType: "user",
    });
    return;
  }

  const featureResult = await checkWorkflowFeaturesForExecutor(
    db,
    workflow.organizationId,
    workflow.nodes as unknown[]
  );
  if (!featureResult.allowed) {
    const gatedFeatureIds = featureResult.violations
      .map((v) => v.featureId)
      .join(",");
    const errorMessage = `Workflow uses features that require a paid plan: ${featureResult.violations
      .map((v) => v.feature.name)
      .join(", ")}`;
    console.warn(
      `[Executor] Feature guard blocked ${triggerType} trigger for workflow ${workflowId}: org=${workflow.organizationId} gated=${gatedFeatureIds}`
    );
    // Record a failed execution row so the user sees this in their dashboard
    // instead of the trigger silently vanishing. Matches the shape of a regular
    // step failure (status=error, completedAt set) so the rest of the UI
    // and metrics pipeline pick it up uniformly.
    const blockedInput = buildInput(message);
    const blockedUserId =
      "userId" in message ? message.userId : workflow.userId;

    // KEEP-693: if a pre-created row exists for this trigger, resolve it in
    // place to the blocked (billing/user) state rather than inserting a second
    // row -- and so the reaper does not later age the orphan to a system P-code.
    // Matches both 'phantom' (scheduler/event-tracker pre-created) and 'pending'
    // (API pre-created for manual triggers). Falls through to an insert when
    // there is no executionId (legacy messages or no pre-create).
    let blockedResolved = false;
    if (message.executionId) {
      const resolved = await db
        .update(workflowExecutions)
        .set({
          status: "error",
          error: errorMessage,
          errorCategory: "billing",
          errorType: "user",
          input: toJsonSafe(blockedInput) as Record<string, unknown>,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(workflowExecutions.id, message.executionId),
            inArray(workflowExecutions.status, ["phantom", "pending"])
          )
        )
        .returning({ id: workflowExecutions.id });
      blockedResolved = resolved.length > 0;
    }

    if (!blockedResolved) {
      const blockedExecutionId = generateId();
      // KEEP-612: attribute the source so blocked scheduled/block/event rows
      // are not NULL in the audit columns. No client request here (SQS
      // dispatch), so ip/country/key are correctly left null.
      const blockedAttribution = buildAttribution({ source: triggerType });
      await withBackstopCapture(
        { workflowId, userId: blockedUserId, source: triggerType },
        () =>
          db.insert(workflowExecutions).values({
            id: blockedExecutionId,
            workflowId,
            userId: blockedUserId,
            status: "error",
            input: toJsonSafe(blockedInput) as Record<string, unknown>,
            error: errorMessage,
            errorCategory: "billing",
            errorType: "user",
            startedAt: new Date(),
            completedAt: new Date(),
            ...blockedAttribution,
          })
      );
    }
    return;
  }

  // Concurrency back-pressure: enforce the same running-execution cap the API
  // routes apply, regardless of dispatch target. Throw rather than drop so the
  // SQS message is redelivered after the visibility timeout once capacity frees,
  // and do it before creating the row so a requeue does not leave orphans.
  const concurrency = await checkConcurrencyLimit(db);
  if (!concurrency.allowed) {
    throw new RequeueSignal(
      `Concurrency limit reached (${concurrency.running}/${concurrency.limit}); requeueing workflow ${workflowId}`
    );
  }

  // Manual and webhook triggers: the API pre-created the execution row as
  // 'pending' before enqueueing. Skip phantom handling entirely and dispatch
  // directly. All billing/feature/concurrency guards above still run.
  if (message.triggerType === "manual" || message.triggerType === "webhook") {
    const nodes = workflow.nodes as WorkflowNode[];
    const target = resolveDispatchTarget(nodes);
    if (target === "api") {
      // EXECUTION_MODE=process routes dispatch back to the app's execute route,
      // which calls executeWorkflowInBackground, which (if
      // WORKFLOW_DISPATCH_VIA_EXECUTOR=1 is set) re-enqueues to SQS — loop.
      throw new Error(
        "EXECUTION_MODE=process is incompatible with WORKFLOW_DISPATCH_VIA_EXECUTOR: " +
          "it routes manual executions back to the API which re-enqueues to SQS. " +
          "Use EXECUTION_MODE=in-process instead."
      );
    }
    // Claim the pre-created 'pending' row exactly once (pending -> running). A
    // redelivery whose row already advanced (still running past the 300s
    // visibility timeout, or terminal) is a duplicate and must be dropped -
    // re-dispatching would double-execute (a second on-chain transaction).
    //
    // TRADEOFF: flipping to 'running' before dispatch means a k8s-target run
    // whose pod never schedules (no step logs) is reaped by the reaper's 30-min
    // 'running' branch (E-0001/workflow_engine) instead of its 5-min 'pending'
    // branch (P-0001/infrastructure) - slower failure surfacing and a
    // misclassified error series. The clean fix is to have the app pre-create
    // manual/webhook rows as 'phantom' (like the scheduler) so a single
    // phantom->pending claim serves every trigger type; deferred as it touches
    // the app execute/webhook routes (and their immediate-visibility UX).
    const claim = await claimPendingForExecution(db, message.executionId);
    if (claim !== "claimed") {
      dropDuplicateDelivery(claim, triggerType, message.executionId);
      return;
    }
    recordConsumeClaim("claimed", triggerType);

    // PAYG: free-tier org past its limit. Charge after the claim so the same
    // single-flight that dedupes deliveries also single-flights the settlement.
    if (
      billingResult.reason === PAYG_OVERFLOW_REASON &&
      message.executionId &&
      !(await settlePaygOverflow({
        workflowId,
        triggerType,
        organizationId: workflow.organizationId,
        executionId: message.executionId,
        claimedStatus: "running",
      }))
    ) {
      return;
    }

    console.log(
      `[Executor] Manual trigger dispatch target: ${target} (mode: ${CONFIG.executionMode})`
    );
    try {
      await dispatchExecution({
        target,
        workflowId,
        executionId: message.executionId,
        input: message.input,
        triggerType: "manual",
        scheduleId: undefined,
      });
    } catch (error) {
      // We claimed pending -> running above, so the phantom/pending backstop in
      // processMessage no longer matches this row. Mark it system_error here
      // (mirrors the schedule/block/event dispatch guard below) then re-throw.
      await failExecutionAsSystemError(db, message.executionId, {
        error:
          error instanceof Error
            ? `Dispatch failed: ${error.message}`
            : "Dispatch failed",
        errorCode: "P-0004",
        statuses: ["running"],
      });
      throw error;
    }
    return;
  }

  const input = buildInput(message);
  const userId = "userId" in message ? message.userId : workflow.userId;
  const serializedInput = toJsonSafe(input) as Record<string, unknown>;

  // KEEP-693: unified phantom row. The scheduler/event-tracker pre-creates a
  // 'phantom' row and passes its id on the message; upgrade it to 'pending' in
  // place (CAS on status='phantom'). The generated id is the fallback for when
  // there is no phantom to upgrade -- a legacy message with no id, or a phantom
  // that is missing (best-effort create failed) or already advanced (a
  // duplicate SQS delivery won the upgrade) -- so a run is never dropped.
  //
  // Hash of the definition the executor actually loaded, so schedule / block /
  // event runs link to their workflow_history version like manual / webhook do.
  const executedWorkflowHash = hashWorkflowDefinition(
    workflow.nodes,
    workflow.edges
  );

  let executionId = generateId();
  if (message.executionId) {
    const claim = await claimPhantomForExecution(
      db,
      message.executionId,
      serializedInput,
      executedWorkflowHash
    );
    if (claim !== "claimed") {
      // Duplicate delivery: the phantom was already claimed/advanced (a
      // redelivery of a run still in flight past the 300s visibility timeout, or
      // one that crashed before delete), or it was discarded/never persisted.
      // Dropping is correct - re-running would double-execute (a second
      // fund-moving on-chain transaction; there is no downstream dedup).
      // Returning lets processMessage delete the message so it stops
      // redelivering.
      dropDuplicateDelivery(claim, triggerType, message.executionId);
      return;
    }
    executionId = message.executionId;
    recordConsumeClaim("claimed", triggerType);
  } else {
    // Legacy / best-effort path: no phantom id, which happens only when the
    // producer's createPhantomExecution failed upstream. Insert a fresh row and
    // run so the trigger is not silently lost. These cannot be deduped without a
    // message nonce (a messageId nonce would break RequeueSignal redelivery and
    // cannot catch a re-SendMessage replay), and they only occur when phantom
    // pre-creation is already failing, so a rare duplicate here is an accepted
    // residual. Downstream dispatch reuses this row, so set attribution directly
    // (SQS dispatch has no inbound client request, so ip/country/api-key stay
    // null). withBackstopCapture emits security.backstop_execution_blocked if the
    // trigger rejects (e.g. owner deactivated in the check->insert race).
    const attribution = buildAttribution({ source: triggerType });
    await withBackstopCapture({ workflowId, userId, source: triggerType }, () =>
      db.insert(workflowExecutions).values({
        id: executionId,
        workflowId,
        userId,
        status: "pending",
        input: serializedInput,
        ...attribution,
        executedWorkflowHash,
      })
    );
    recordConsumeClaim("idless_insert", triggerType);
  }

  console.log(`[Executor] Created execution record: ${executionId}`);

  // PAYG: free-tier org past its limit. Charge after the claim so the same
  // single-flight that dedupes deliveries also single-flights the settlement.
  if (
    billingResult.reason === PAYG_OVERFLOW_REASON &&
    !(await settlePaygOverflow({
      workflowId,
      triggerType,
      organizationId: workflow.organizationId,
      executionId,
      claimedStatus: "pending",
    }))
  ) {
    return;
  }

  // Counter for the "zero executions in N min" alert family (KEEP-556).
  // Increments here for every SQS-triggered run regardless of dispatch target
  // (k8s-job / in-process / api). The route.ts handler only increments when it
  // creates the row itself - so manual and webhook flows go through there, and
  // schedule / block / event go through here, with no double-count when the
  // executor hands off via process mode and the API uses our pre-existing row.
  getMetricsCollector().incrementCounter(
    MetricNames.WORKFLOW_EXECUTIONS_STARTED_TOTAL,
    {
      [LabelKeys.TRIGGER_TYPE]: triggerType,
    }
  );

  const nodes = workflow.nodes as WorkflowNode[];
  const target = resolveDispatchTarget(nodes);
  console.log(
    `[Executor] Dispatch target: ${target} (mode: ${CONFIG.executionMode})`
  );

  try {
    await dispatchExecution({
      target,
      workflowId,
      executionId,
      input,
      triggerType,
      scheduleId: getScheduleId(message),
    });
  } catch (error) {
    // Don't leak the inserted row as 'pending' if dispatch fails. The
    // k8s-job target updates the row internally; this outer guard covers
    // api / in-process / future targets uniformly. The status='pending'
    // filter prevents overwriting a status the runtime already set if
    // the failure happened after the workflow started running.
    await failExecutionAsSystemError(db, executionId, {
      error:
        error instanceof Error
          ? `Dispatch failed: ${error.message}`
          : "Dispatch failed",
      errorCode: "P-0004",
      statuses: ["pending"],
    });
    throw error;
  }
}

/**
 * Verify a trigger message's HMAC signature and validate its shape
 * before it can drive an execution. Returns the first hard failure (or null),
 * plus whether a validly-signed message is older than the advisory freshness
 * threshold. Freshness never produces a failure - a backlog can legitimately
 * hold old messages, so age alone must not drop a real trigger.
 */
export function evaluateSqsMessageAuth(
  rawBody: string,
  attributes: Record<string, MessageAttributeValue> | undefined,
  body: ExecutorMessage
): {
  failure:
    | "unsigned"
    | "unknown_caller"
    | "bad_signature"
    | "invalid_schema"
    | null;
  stale: boolean;
} {
  const sig = verifySqsMessageSignature(CONFIG.sqsQueueUrl, rawBody, attributes);
  if (!sig.ok) {
    return { failure: sig.reason, stale: false };
  }
  const stale = Math.abs(sig.ageSeconds) > CONFIG.sqsHmacMaxAgeSeconds;
  const parsed = executorMessageSchema.safeParse(body);
  if (!parsed.success) {
    return { failure: "invalid_schema", stale };
  }
  return { failure: null, stale };
}

// Reject a message that was never processed - malformed JSON, or a forged /
// invalid message dropped in enforce mode. When a DLQ is configured, copy the
// raw message (body + original attributes, plus a reason) into it before
// deleting from the main queue, so the rejected message is retained for audit
// rather than vanishing behind a log line. A redrive policy cannot capture
// these: the delete removes the message on first receive, so it never reaches
// maxReceiveCount. Falls back to a plain delete when SQS_DLQ_URL is unset.
async function dropMessage(message: Message, reason: string): Promise<void> {
  if (CONFIG.sqsDlqUrl && message.Body) {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: CONFIG.sqsDlqUrl,
          MessageBody: message.Body,
          MessageAttributes: {
            ...message.MessageAttributes,
            "X-KH-Reason": { DataType: "String", StringValue: reason },
          },
        })
      );
    } catch (error) {
      // A DLQ hiccup must never strand the message on the main queue - fall
      // through to the delete so a bad payload cannot wedge the poll loop.
      console.error(
        `[Executor] Failed to copy dropped message (${reason}) to DLQ:`,
        error
      );
    }
  }

  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: CONFIG.sqsQueueUrl,
      ReceiptHandle: message.ReceiptHandle,
    })
  );
}

export async function processMessage(
  message: Message,
  // The message processor is injectable so tests can drive the success and
  // failure branches without standing up the full executor pipeline.
  runMessage: (body: ExecutorMessage) => Promise<void> = processExecutorMessage
): Promise<void> {
  if (!(message.Body && message.ReceiptHandle)) {
    console.error("[Executor] Invalid message:", message);
    return;
  }

  let body: ExecutorMessage;
  try {
    body = JSON.parse(message.Body);
  } catch {
    console.error("[Executor] Malformed message body, deleting:", message.Body);
    await dropMessage(message, "malformed_json");
    return;
  }

  // Authenticate + validate the message before it can drive a
  // fund-moving execution. In "warn" mode we record metrics but still process
  // (so shipping this ahead of every producer signing cannot cause an outage);
  // in "enforce" mode a hard failure drops the message - a forged/corrupt
  // message cannot be made valid by redelivery, so it is copied to the DLQ (when
  // configured) for audit and removed from the main queue.
  if (CONFIG.sqsHmacMode !== "off") {
    const auth = evaluateSqsMessageAuth(
      message.Body,
      message.MessageAttributes,
      body
    );
    // Exactly one auth_result per message (a failure outranks stale, stale
    // outranks valid) so the metric's total across labels equals messages
    // processed - the rollout gate reads these series.
    const result = auth.failure ?? (auth.stale ? "stale" : "valid");
    getMetricsCollector().incrementCounter(MetricNames.SQS_MESSAGE_AUTH, {
      [LabelKeys.AUTH_RESULT]: result,
      [LabelKeys.MODE]: CONFIG.sqsHmacMode,
    });

    // Staleness is advisory unless SQS_HMAC_MAX_AGE_ENFORCE is set, in which case
    // an over-age message becomes a hard failure (bounds replay to the window).
    const staleRejected = auth.stale && CONFIG.sqsHmacMaxAgeEnforce;
    if (auth.stale && !staleRejected) {
      console.warn(
        `[Executor] SQS message older than ${CONFIG.sqsHmacMaxAgeSeconds}s (advisory) for workflow ${body.workflowId}`
      );
    }

    const failure = auth.failure ?? (staleRejected ? "stale" : null);
    if (failure) {
      console.warn(
        `[Executor] SQS message rejected (${failure}, mode=${CONFIG.sqsHmacMode}) for workflow ${body.workflowId}`
      );
      if (CONFIG.sqsHmacMode === "enforce") {
        await dropMessage(message, failure);
        return;
      }
    }
  }

  try {
    await runMessage(body);

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: CONFIG.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      })
    );

    console.log(`[Executor] Message deleted for workflow ${body.workflowId}`);
  } catch (error) {
    // KEEP-853: a RequeueSignal is a deliberate back-pressure skip (executor at
    // capacity). Leave the message on the queue so SQS redelivers it after the
    // visibility timeout, and leave the phantom row untouched for that retry.
    if (error instanceof RequeueSignal) {
      console.warn(`[Executor] Requeueing workflow ${body.workflowId}:`, error);
      return;
    }

    // Genuine processing failure. Mark the in-flight execution as a system
    // error immediately (instead of waiting for the reaper), then delete the
    // message so a poison payload does not redeliver forever and so the
    // resolved row is not re-claimed into a duplicate.
    console.error(
      `[Executor] Failed to process workflow ${body.workflowId}:`,
      error
    );
    const marked = await failExecutionAsSystemError(db, body.executionId, {
      error:
        error instanceof Error
          ? `Message processing failed: ${error.message}`
          : "Message processing failed",
      errorCode: "E-0004",
    });
    if (!marked) {
      // The row already advanced past phantom/pending (e.g. to running) or is
      // missing, so the immediate mark did not apply. Deleting the message below
      // is still correct, but the row is now left for the reaper; log that so it
      // does not look like the backstop resolved it.
      console.warn(
        `[Executor] Backstop did not mark execution ${body.executionId} as system_error (already advanced or missing); leaving it for the reaper`
      );
    }
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: CONFIG.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      })
    );
  }
}

async function listen(): Promise<void> {
  console.log("[Executor] Starting unified workflow executor...");
  console.log(`[Executor] Execution mode: ${CONFIG.executionMode}`);
  console.log(`[Executor] Queue URL: ${CONFIG.sqsQueueUrl}`);
  console.log(`[Executor] Runner image: ${CONFIG.runnerImage}`);
  console.log(`[Executor] K8s namespace: ${CONFIG.namespace}`);

  // Wire up Prometheus dual-write. The Next.js app does this in
  // instrumentation.ts; the executor is a separate tsx-launched process and
  // never runs Next.js's instrumentation hook, so without this its
  // getMetricsCollector() calls would only hit the console collector and the
  // executor's /metrics endpoint would never see the counter series. See
  // KEEP-556 for the missing-counter symptom this fixes.
  if (process.env.METRICS_COLLECTOR === "prometheus") {
    const { prometheusMetricsCollector } = await import(
      "../lib/metrics/collectors/prometheus"
    );
    const { createDualWriteCollector } = await import(
      "../lib/metrics/collectors/dual"
    );
    const { setMetricsCollector } = await import("../lib/metrics");
    setMetricsCollector(createDualWriteCollector(prometheusMetricsCollector));
    console.log(
      "[Executor] Prometheus dual-write metrics collector initialized"
    );
  }

  assertHmacSecretSet();
  await assertTurnkeyEnvForActiveWallets(db);

  // Health check + metrics server
  const healthServer = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "keeperhub-executor",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (req.url === "/metrics" && req.method === "GET") {
      if (process.env.METRICS_COLLECTOR !== "prometheus") {
        res.writeHead(404);
        res.end();
        return;
      }
      (async (): Promise<void> => {
        try {
          const { getApiProcessMetrics, getPrometheusContentType } =
            await import("../lib/metrics/prometheus-api");
          const metrics = await getApiProcessMetrics();
          res.writeHead(200, {
            "Content-Type": getPrometheusContentType(),
            "Cache-Control": "no-store, no-cache, must-revalidate",
          });
          res.end(metrics);
        } catch (error) {
          console.error("[Executor] Failed to serve metrics:", error);
          res.writeHead(500);
          res.end("Failed to collect metrics");
        }
      })();
      return;
    }

    if (req.url === "/metrics/ingest" && req.method === "POST") {
      if (process.env.METRICS_COLLECTOR !== "prometheus") {
        res.writeHead(404);
        res.end();
        return;
      }
      const expectedToken = process.env.METRICS_INGEST_TOKEN;
      if (!expectedToken) {
        res.writeHead(503);
        res.end("Ingest not configured");
        return;
      }
      if (req.headers["x-ingest-token"] !== expectedToken) {
        res.writeHead(401);
        res.end();
        return;
      }
      (async (): Promise<void> => {
        try {
          const body = await readJsonBody(req);
          if (!isIngestPayload(body)) {
            res.writeHead(400);
            res.end("Invalid ingest payload");
            return;
          }
          const { applied, skipped } = await applyCounterDeltas(body.deltas);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ applied, skipped }));
        } catch (error) {
          console.error("[Executor] Metrics ingest failed:", error);
          res.writeHead(500);
          res.end("Ingest failed");
        }
      })();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  healthServer.listen(CONFIG.healthPort, () => {
    console.log(
      `[Executor] Health check server listening on port ${CONFIG.healthPort}`
    );
  });

  const shutdown = async (): Promise<void> => {
    console.log("\n[Executor] Shutting down...");
    healthServer.close();
    await queryClient.end();
    console.log("[Executor] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("SIGUSR1", () => {
    console.warn(
      "[Security] SIGUSR1 received; inspector activation suppressed"
    );
  });

  // SQS polling loop
  while (true) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: CONFIG.sqsQueueUrl,
          MaxNumberOfMessages: CONFIG.maxMessages,
          WaitTimeSeconds: CONFIG.waitTimeSeconds,
          VisibilityTimeout: CONFIG.visibilityTimeout,
          MessageAttributeNames: ["All"],
        })
      );

      const messages = response.Messages || [];

      if (messages.length > 0) {
        console.log(`[Executor] Received ${messages.length} messages`);

        const results = await Promise.allSettled(
          messages.map((msg) => processMessage(msg))
        );

        for (const [idx, result] of results.entries()) {
          if (result.status === "rejected") {
            console.error(`[Executor] Message ${idx} failed:`, result.reason);
          }
        }
      }
    } catch (error) {
      console.error("[Executor] Error receiving messages:", error);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Only auto-start the poll loop when run as the executor entrypoint, not when
// the module is imported by tests (which drive processMessage directly).
if (!process.env.VITEST) {
  listen().catch((error: unknown) => {
    console.error("[Executor] Fatal startup error:", error);
    process.exit(1);
  });
}
