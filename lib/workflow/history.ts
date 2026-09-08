import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowHistory } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";
import { computeVersionDiff } from "@/lib/workflow/version-diff";

/**
 * One saved version per workflow edit. Holds the full snapshot (for load /
 * restore) plus a deep-diff against the previous version, and mirrors the
 * audit-log actor capture so "who changed this" is answerable here too.
 *
 * Every write is best-effort: a failure is logged but never thrown, so a
 * history hiccup can never block the workflow save that triggered it.
 */

export type WorkflowSnapshotActor = {
  userId: string | null;
  organizationId: string | null;
  authMethod: string;
};

// The subset of a workflow row we snapshot. Loosely typed so callers can pass
// the live row or a historical snapshot without a circular schema import.
export type WorkflowSnapshotInput = {
  name?: string | null;
  description?: string | null;
  nodes?: unknown;
  edges?: unknown;
  visibility?: string | null;
  enabled?: boolean | null;
  isListed?: boolean | null;
  listedSlug?: string | null;
  inputSchema?: unknown;
  outputMapping?: unknown;
  priceUsdcPerCall?: string | null;
  workflowType?: string | null;
  category?: string | null;
  chain?: string | null;
};

function buildSnapshot(wf: WorkflowSnapshotInput): Record<string, unknown> {
  return {
    name: wf.name ?? null,
    description: wf.description ?? null,
    nodes: wf.nodes ?? [],
    edges: wf.edges ?? [],
    visibility: wf.visibility ?? null,
    enabled: wf.enabled ?? null,
    isListed: wf.isListed ?? null,
    listedSlug: wf.listedSlug ?? null,
    inputSchema: wf.inputSchema ?? null,
    outputMapping: wf.outputMapping ?? null,
    priceUsdcPerCall: wf.priceUsdcPerCall ?? null,
    workflowType: wf.workflowType ?? null,
    category: wf.category ?? null,
    chain: wf.chain ?? null,
  };
}

export async function recordWorkflowSnapshot(args: {
  workflowId: string;
  before: WorkflowSnapshotInput | null;
  after: WorkflowSnapshotInput;
  actor: WorkflowSnapshotActor;
  source: "create" | "update" | "listing";
}): Promise<void> {
  const { workflowId, before, after, actor, source } = args;
  try {
    const [latest] = await db
      .select({
        version: workflowHistory.version,
        contentHash: workflowHistory.contentHash,
      })
      .from(workflowHistory)
      .where(eq(workflowHistory.workflowId, workflowId))
      .orderBy(desc(workflowHistory.version))
      .limit(1);

    const previousVersion = latest?.version ?? null;
    const version = (previousVersion ?? 0) + 1;
    // Store the semantic diff (what changed: nodes/connections/settings), so
    // the timeline can show each version's changes without re-deriving them.
    const change = before ? computeVersionDiff(before, after) : null;

    // Don't record a no-op version: an autosave that only moved a node (or
    // changed nothing meaningful) produces an empty diff. Skipping these keeps
    // the timeline to real edits. The first version (no `before`) always lands.
    if (before && change && !change.hasChanges) {
      return;
    }

    await db.insert(workflowHistory).values({
      workflowId,
      organizationId: actor.organizationId,
      version,
      changedByUserId: actor.userId,
      authMethod: actor.authMethod,
      source,
      snapshot: buildSnapshot(after),
      change,
      contentHash: hashWorkflowDefinition(after.nodes, after.edges),
      previousVersion,
      previousHash: latest?.contentHash ?? null,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to record workflow history snapshot",
      error,
      { workflowId, source }
    );
  }
}
