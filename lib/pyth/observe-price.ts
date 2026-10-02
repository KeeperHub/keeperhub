import { and, eq } from "drizzle-orm";
import {
  checkDispatchAdmission,
  type DispatchRefusal,
} from "@/lib/billing/dispatch-admission";
import { db } from "@/lib/db";
import {
  organization,
  pythTriggerCheckpoints,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { buildAttribution } from "@/lib/security/request-attribution";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";
import { getWorkflowExecutability } from "@/lib/workflow/executable";
import { evaluatePythPrice, type PythPriceUpdate } from "./price-trigger";
import { findPythConfig, hashPythConfig } from "./trigger-config";

export type PythObservationRequest = {
  workflowId: string;
  configHash: string;
  sessionId: string;
} & (
  | { action: "observe"; update: PythPriceUpdate; rebaseline?: boolean }
  | { action: "pending" }
  | { action: "ack"; executionId: string }
);

export type PythPendingDispatch = NonNullable<
  typeof pythTriggerCheckpoints.$inferSelect.pending
>;
export type PythObservationResult = {
  outcome: string;
  pending?: PythPendingDispatch & { workflowId: string; userId: string };
};

const LEASE_MS = 45_000;

/**
 * Thrown inside the observation transaction to roll it back when a crossing
 * needs an admission decision that has not been resolved yet.
 */
export class PythAdmissionRequired extends Error {
  readonly organizationId: string;
  readonly nodes: unknown[];

  constructor(organizationId: string, nodes: unknown[]) {
    super("Pyth dispatch admission required");
    this.organizationId = organizationId;
    this.nodes = nodes;
  }
}

/**
 * The checkpoint and phantom row commit together before anything is enqueued.
 * A lost HTTP reply or SQS acknowledgement leaves the same pending execution
 * available for redelivery; only the executor's existing CAS starts it.
 *
 * Admission reads plan and usage through the default pool, so it must not run
 * while the transaction holds a connection and the workflow row lock. Only a
 * crossing needs it, so ordinary ticks skip it: a crossing rolls the
 * transaction back, admission resolves outside it, and the observation is
 * replayed once with the answer. The executor re-runs admission before it
 * claims the row, so a decision that goes stale in between is harmless.
 */
export async function observePythPrice(
  command: PythObservationRequest,
  request: Request,
  database: typeof db = db
): Promise<PythObservationResult> {
  try {
    return await observeInTransaction(command, request, database);
  } catch (error) {
    if (!(error instanceof PythAdmissionRequired)) {
      throw error;
    }
    const refusal = await checkDispatchAdmission({
      organizationId: error.organizationId,
      nodes: error.nodes,
    });
    return await observeInTransaction(command, request, database, refusal);
  }
}

async function observeInTransaction(
  command: PythObservationRequest,
  request: Request,
  database: typeof db,
  admission?: DispatchRefusal | null
): Promise<PythObservationResult> {
  return await database.transaction(async (tx) => {
    const [workflow] = await tx
      .select()
      .from(workflows)
      .where(eq(workflows.id, command.workflowId))
      .for("update");
    if (
      !workflow ||
      workflow.deletedAt ||
      !workflow.enabled ||
      workflow.deactivatedAt
    ) {
      return { outcome: "inactive" };
    }
    const [org] = await tx
      .select({
        deactivatedAt: organization.deactivatedAt,
        haltedAt: organization.haltedAt,
      })
      .from(organization)
      .where(eq(organization.id, workflow.organizationId));
    if (
      !(
        org &&
        getWorkflowExecutability({
          ...workflow,
          orgDeactivatedAt: org.deactivatedAt,
          orgHaltedAt: org.haltedAt,
        }).executable
      )
    ) {
      return { outcome: "inactive" };
    }
    const config = findPythConfig(workflow.nodes);
    if (!config || hashPythConfig(config) !== command.configHash) {
      return { outcome: "config_changed" };
    }
    const now = new Date();
    await tx
      .insert(pythTriggerCheckpoints)
      .values({
        workflowId: workflow.id,
        configHash: command.configHash,
      })
      .onConflictDoNothing();
    const [stored] = await tx
      .select()
      .from(pythTriggerCheckpoints)
      .where(eq(pythTriggerCheckpoints.workflowId, workflow.id));
    let checkpoint = stored;
    let changed = false;
    const invalidPending =
      checkpoint.pending &&
      (checkpoint.pending.triggerData.expiresAt <= now.getTime() ||
        checkpoint.configHash !== command.configHash);
    if (invalidPending && checkpoint.pending) {
      await tx
        .update(workflowExecutions)
        .set({
          status: "skipped",
          billable: false,
          completedAt: now,
          error:
            "Pyth signal expired or its trigger configuration changed before dispatch.",
        })
        .where(
          and(
            eq(workflowExecutions.id, checkpoint.pending.executionId),
            eq(workflowExecutions.status, "phantom")
          )
        );
      checkpoint = {
        ...checkpoint,
        pending: null,
        armed: false,
        lastPublishTime: null,
      };
      changed = true;
    }
    if (checkpoint.configHash !== command.configHash) {
      checkpoint = {
        ...checkpoint,
        configHash: command.configHash,
        sessionId: null,
        leaseUntil: null,
        lastPublishTime: null,
        armed: false,
        pending: null,
      };
      changed = true;
    }
    if (
      command.action === "ack" &&
      checkpoint.pending?.executionId === command.executionId
    ) {
      checkpoint = { ...checkpoint, pending: null };
      changed = true;
    }
    // Every tick and recovery sweep reaches this point, most of them with
    // nothing to change; only write when something did.
    if (changed) {
      await tx
        .update(pythTriggerCheckpoints)
        .set({ ...checkpoint, updatedAt: now })
        .where(eq(pythTriggerCheckpoints.workflowId, workflow.id));
    }
    if (checkpoint.pending) {
      return {
        outcome: "pending",
        pending: {
          ...checkpoint.pending,
          workflowId: workflow.id,
          userId: workflow.userId,
        },
      };
    }
    if (command.action !== "observe") {
      return { outcome: command.action === "ack" ? "acknowledged" : "idle" };
    }
    if (
      checkpoint.sessionId !== command.sessionId &&
      checkpoint.leaseUntil &&
      checkpoint.leaseUntil > now
    ) {
      return { outcome: "leased" };
    }
    // A new owner (takeover, restart, config reset) or an explicit reconnect
    // rebaselines. A lapsed lease under the same session does not: nobody
    // else wrote in between, and treating it as a baseline would stop a
    // slowly sampled workflow from ever firing.
    const resetBaseline =
      command.rebaseline === true || checkpoint.sessionId !== command.sessionId;
    const evaluated = evaluatePythPrice(
      config,
      checkpoint,
      command.update,
      now.getTime() / 1000,
      resetBaseline
    );
    if (
      ["stale", "future", "out_of_order", "wrong_feed"].includes(
        evaluated.outcome
      )
    ) {
      return { outcome: evaluated.outcome };
    }
    let pending: PythPendingDispatch | null = null;
    let outcome: string = evaluated.outcome;
    if (evaluated.signal) {
      if (admission === undefined) {
        throw new PythAdmissionRequired(
          workflow.organizationId,
          workflow.nodes as unknown[]
        );
      }
      const refusal = admission;
      const dispatchKey = `${evaluated.signal.sourceUpdateId}:${workflow.id}:${command.configHash}`;
      const [execution] = await tx
        .insert(workflowExecutions)
        .values({
          workflowId: workflow.id,
          organizationId: workflow.organizationId,
          userId: workflow.userId,
          status: refusal ? "skipped" : "phantom",
          billable: false,
          input: { ...evaluated.signal, configHash: command.configHash },
          dispatchKey,
          error: refusal?.message ?? null,
          completedAt: refusal ? now : null,
          executedWorkflowHash: hashWorkflowDefinition(
            workflow.nodes,
            workflow.edges
          ),
          ...buildAttribution({
            request,
            source: "upstream",
            credentialType: "internal",
            credentialLabel: "events",
          }),
        })
        .onConflictDoNothing({ target: workflowExecutions.dispatchKey })
        .returning({ id: workflowExecutions.id });
      if (execution && !refusal) {
        pending = {
          executionId: execution.id,
          configHash: command.configHash,
          triggerData: evaluated.signal,
        };
      }
      outcome = execution ? "crossed" : "duplicate";
      if (refusal) {
        outcome = "refused";
      }
    }
    await tx
      .update(pythTriggerCheckpoints)
      .set({
        ...evaluated.checkpoint,
        pending,
        sessionId: command.sessionId,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      })
      .where(eq(pythTriggerCheckpoints.workflowId, workflow.id));
    return {
      outcome,
      ...(pending
        ? {
            pending: {
              ...pending,
              workflowId: workflow.id,
              userId: workflow.userId,
            },
          }
        : {}),
    };
  });
}
