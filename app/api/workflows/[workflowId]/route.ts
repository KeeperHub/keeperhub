import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { projects, publicTags, tags, workflowExecutions, workflowHistory, workflowPublicTags, workflowSchedules, workflows } from "@/lib/db/schema";
import {
  deriveWorkflowType,
  findFirstWriteActionNode,
} from "@/lib/mcp/calldata";
import {
  findBareAtLiterals,
  isInputSchemaPresent,
} from "@/lib/mcp/listing-validators";
import { IntervalTooSmallError } from "@/lib/cron-utils";
import {
  extractScheduleConfig,
  syncWorkflowSchedule,
} from "@/lib/schedule-service";
import { sanitizeDescription } from "@/lib/sanitize-description";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import {
  canShareExecutionStatus,
  clearShareExecutionStatus,
} from "@/lib/workflow/share-execution-status";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";
import { recordWorkflowSnapshot } from "@/lib/workflow/history";
import { sanitizeWorkflowData } from "@/lib/workflow/editor/sanitize-nodes";
import { softDeleteValues } from "@/lib/workflow/soft-delete";
import { isReservedSlug } from "@/lib/workflow/reserved-slugs";
import {
  formatActionConfigValidationResponse,
  hasDraftActionNodes,
  validateWorkflowActionConfigs,
  type WorkflowNodeForValidation,
} from "@/lib/workflow/validation/action-config";
import { findInvalidTemplateTokens } from "@/lib/workflow/validation/template-syntax";
async function fetchWorkflowPublicTags(
  workflowId: string
): Promise<Array<{ id: string; name: string; slug: string }>> {
  const rows = await db
    .select({
      id: publicTags.id,
      name: publicTags.name,
      slug: publicTags.slug,
    })
    .from(workflowPublicTags)
    .innerJoin(publicTags, eq(workflowPublicTags.publicTagId, publicTags.id))
    .where(eq(workflowPublicTags.workflowId, workflowId));
  return rows;
}

// Helper to strip sensitive data from nodes for public viewing
function sanitizeNodesForPublicView(
  nodes: Record<string, unknown>[]
): Record<string, unknown>[] {
  return nodes.map((node) => {
    const sanitizedNode = { ...node };
    if (
      sanitizedNode.data &&
      typeof sanitizedNode.data === "object" &&
      sanitizedNode.data !== null
    ) {
      const data = { ...(sanitizedNode.data as Record<string, unknown>) };
      // Remove integrationId from config to not expose which integrations are used
      if (
        data.config &&
        typeof data.config === "object" &&
        data.config !== null
      ) {
        const { integrationId: _, ...configWithoutIntegration } =
          data.config as Record<string, unknown>;
        data.config = configWithoutIntegration;
      }
      sanitizedNode.data = data;
    }
    return sanitizedNode;
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request, { required: false });
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { userId, organizationId } = authContext;

    // First, try to find the workflow
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // Access control:
    // - Public workflows: anyone can view (sanitized), Hub-listed
    // - Unlisted workflows: anyone with the link can view (sanitized), not on Hub
    // - Private workflows: owner or org member can view
    // - Anonymous workflows: only owner can view
    if (!access.hasFullAccess && workflow.visibility === "private") {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // KEEP-440: a soft-deleted workflow stays readable for its owner/org so the
    // UI can render a deleted marker, but is gone for everyone else.
    if (access.isDeleted && !access.hasFullAccess) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const hasFullAccess = access.hasFullAccess;

    // ?version=N returns a historical snapshot instead of the live row. It is
    // the edit history of a workflow the caller already has full access to, so
    // any current org member can read it (same gate as the /history timeline);
    // the org-wide security audit stays admin/owner only elsewhere.
    const versionParam = new URL(request.url).searchParams.get("version");
    if (versionParam !== null) {
      const versionNumber = Number.parseInt(versionParam, 10);
      if (Number.isNaN(versionNumber)) {
        return NextResponse.json({ error: "Invalid version" }, { status: 400 });
      }
      if (!(hasFullAccess && userId && workflow.organizationId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const [historyRow] = await db
        .select()
        .from(workflowHistory)
        .where(
          and(
            eq(workflowHistory.workflowId, workflowId),
            eq(workflowHistory.version, versionNumber)
          )
        )
        .limit(1);
      if (!historyRow) {
        return NextResponse.json(
          { error: "Version not found" },
          { status: 404 }
        );
      }
      const snapshot = (historyRow.snapshot ?? {}) as Record<string, unknown>;
      return NextResponse.json({
        ...workflow,
        ...snapshot,
        id: workflow.id,
        version: historyRow.version,
        isHistoricalVersion: true,
        versionCreatedAt: historyRow.createdAt.toISOString(),
        createdAt: workflow.createdAt.toISOString(),
        updatedAt: workflow.updatedAt.toISOString(),
        isOwner: hasFullAccess,
      });
    }

    const workflowTags = await fetchWorkflowPublicTags(workflowId);

    // For public workflows viewed by non-owners, sanitize sensitive data
    const responseData = {
      ...workflow,
      nodes: hasFullAccess
        ? workflow.nodes
        : sanitizeNodesForPublicView(
            workflow.nodes as Record<string, unknown>[]
          ),
      publicTags: workflowTags,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
      // Note: `isOwner` controls edit permissions in the frontend.
      // We use `hasFullAccess` here so that all org members can edit,
      // not just the original creator. This is a bit of a misnomer but
      // avoids refactoring the frontend atom naming (isWorkflowOwnerAtom).
      isOwner: hasFullAccess,
    };

    // INFRA-05: Sanitize description for non-owner reads of listed workflows
    if (!hasFullAccess && workflow.isListed && responseData.description) {
      responseData.description = sanitizeDescription(responseData.description);
    }

    return NextResponse.json(responseData);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflow",
      },
      { status: 500 }
    );
  }
}

// Helper to build update data from request body
function buildUpdateData(
  body: Record<string, unknown>
): Record<string, unknown> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  const fields = [
    "name",
    "description",
    "nodes",
    "edges",
    "visibility",
    "enabled", // keeperhub custom field //
    "projectId", // keeperhub custom field //
    "tagId", // keeperhub custom field //
    "isListed", // v1.7 listing fields //
    "listedSlug", // v1.7 listing fields //
    "inputSchema", // v1.7 listing fields //
    "outputMapping", // v1.7 listing fields //
    "priceUsdcPerCall", // v1.7 listing fields //
    "shareExecutionStatus",
  ];
  for (const field of fields) {
    if (body[field] !== undefined) {
      updateData[field] = body[field];
    }
  }

  // Sanitize nodes/edges: strip React Flow UI state and normalize MCP-generated formats
  if (Array.isArray(updateData.nodes) || Array.isArray(updateData.edges)) {
    const nodes = (updateData.nodes ?? []) as Record<string, unknown>[];
    const edges = (updateData.edges ?? []) as Record<string, unknown>[];
    const sanitized = sanitizeWorkflowData(nodes, edges);
    if (updateData.nodes !== undefined) {
      updateData.nodes = sanitized.nodes;
    }
    if (updateData.edges !== undefined) {
      updateData.edges = sanitized.edges;
    }
  }

  return updateData;
}

// Helper to validate visibility value
function isValidVisibility(visibility: unknown): boolean {
  return (
    visibility === undefined ||
    visibility === "private" ||
    visibility === "unlisted" ||
    visibility === "public"
  );
}

// Helper to validate workflow access for PATCH/DELETE operations
async function validateWorkflowAccess(
  workflowId: string,
  userId: string | null,
  organizationId: string | null,
  authMethod: "api-key" | "oauth" | "session"
): Promise<{
  workflow: typeof workflows.$inferSelect | null;
  hasAccess: boolean;
}> {
  const existingWorkflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
  });

  if (!existingWorkflow) {
    return { workflow: null, hasAccess: false };
  }

  const access = await getWorkflowAccess(existingWorkflow, {
    userId,
    organizationId,
    authMethod,
  });

  // KEEP-440: a soft-deleted workflow is not mutable. PATCH and DELETE both
  // treat it as not-found rather than re-deleting or editing a tombstone.
  return {
    workflow: existingWorkflow,
    hasAccess: access.hasFullAccess && !access.isDeleted,
  };
}

async function handlePostUpdateSideEffects(
  workflowId: string,
  body: Record<string, unknown>
): Promise<void> {
  // Tags are Hub-discovery only; clear them on any demote off of "public",
  // including demote-to-unlisted (link-only) and demote-to-private.
  if (body.visibility === "private" || body.visibility === "unlisted") {
    await db
      .delete(workflowPublicTags)
      .where(eq(workflowPublicTags.workflowId, workflowId));
  }

  // Marketplace leaderboard caches tags + isListed for 60s. Drop the cache
  // whenever a change might have flipped a row in or out of the listed set,
  // or rewritten the tag column on a still-listed row.
  if (
    body.isListed !== undefined ||
    body.visibility !== undefined ||
    body.priceUsdcPerCall !== undefined
  ) {
    revalidateTag("marketplace", "max");
  }

  if (body.nodes !== undefined) {
    const syncResult = await syncWorkflowSchedule(
      workflowId,
      body.nodes as Parameters<typeof syncWorkflowSchedule>[1]
    );
    if (!syncResult.synced) {
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow] Schedule sync failed",
        syncResult.error,
        { workflow_id: workflowId }
      );
    }
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE);
    if (scopeError) {
      return scopeError;
    }

    const { userId, organizationId } = authContext;
    const { workflow: existingWorkflow, hasAccess } =
      await validateWorkflowAccess(
        workflowId,
        userId,
        organizationId,
        authContext.authMethod
      );

    if (!(existingWorkflow && hasAccess)) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const body = await request.json();

    // A deactivated workflow is fully off and cannot be re-enabled from the
    // app. Clearing deactivatedAt (reactivation) is a DB/ops action, mirroring
    // user and org reactivation, so the editor toggle cannot flip it back on.
    if (existingWorkflow.deactivatedAt && body.enabled === true) {
      return NextResponse.json(
        { error: "Workflow is deactivated and cannot be enabled" },
        { status: 409 }
      );
    }

    if (Array.isArray(body.nodes)) {
      // KEEP-468: parse every `{{...}}` token at save time so grammar typos
      // (the n8n-style `{{$trigger.input.ts}}`-shaped errors that produced
      // on-chain corruption during the hackathon) are rejected with line/path
      // errors instead of running through the editor and failing at runtime.
      const invalidTemplates = findInvalidTemplateTokens(body.nodes);
      if (invalidTemplates.length > 0) {
        return NextResponse.json(
          {
            error: "INVALID_TEMPLATE_SYNTAX",
            message:
              "Workflow contains template tokens that do not parse. Fix the listed references and save again.",
            invalidTemplates,
          },
          { status: 400 }
        );
      }

      // KEEP-581: schedule interval pre-check. Runs before the DB update so
      // a rejected sub-60s value never lands as persisted nodes paired with
      // an unsynced schedule. extractScheduleConfig is the only thing that
      // throws here; bad timezones/cron strings still take the warn-and-
      // continue path in handlePostUpdateSideEffects.
      try {
        extractScheduleConfig(
          body.nodes as Parameters<typeof extractScheduleConfig>[0]
        );
      } catch (error) {
        if (error instanceof IntervalTooSmallError) {
          return NextResponse.json(
            {
              error: "SCHEDULE_INTERVAL_TOO_SMALL",
              message: error.message,
            },
            { status: 400 }
          );
        }
        throw error;
      }
    }

    // Validate visibility value if provided
    if (!isValidVisibility(body.visibility)) {
      return NextResponse.json(
        {
          error:
            "Invalid visibility value. Must be 'private', 'unlisted', or 'public'",
        },
        { status: 400 }
      );
    }

    // Validate projectId/tagId ownership when provided
    if (body.projectId !== undefined || body.tagId !== undefined) {
      const targetOrgId = existingWorkflow.organizationId || organizationId;

      if (!targetOrgId) {
        if (body.projectId || body.tagId) {
          return NextResponse.json(
            { error: "Cannot assign project or tag without an organization" },
            { status: 400 }
          );
        }
      } else {
        if (body.projectId) {
          const projRows = await db
            .select({ orgId: projects.organizationId })
            .from(projects)
            .where(eq(projects.id, body.projectId));
          if (!(projRows[0] && projRows[0].orgId === targetOrgId)) {
            return NextResponse.json(
              { error: "Project not found in this organization" },
              { status: 404 }
            );
          }
        }
        if (body.tagId) {
          const tagRows = await db
            .select({ orgId: tags.organizationId })
            .from(tags)
            .where(eq(tags.id, body.tagId));
          if (!(tagRows[0] && tagRows[0].orgId === targetOrgId)) {
            return NextResponse.json(
              { error: "Tag not found in this organization" },
              { status: 404 }
            );
          }
        }
      }
    }

    // Reserved-slug guard (HUB-11): reject listed slugs that collide with reserved
    // path segments under /hub/tags/[tag]. Applies only to non-null new values.
    if (
      body.listedSlug !== undefined &&
      body.listedSlug !== null &&
      typeof body.listedSlug === "string" &&
      isReservedSlug(body.listedSlug)
    ) {
      return NextResponse.json(
        {
          error: `"${body.listedSlug}" is a reserved word and cannot be used.`,
        },
        { status: 400 }
      );
    }

    // Slug immutability: reject changes to listedSlug when workflow is already listed
    if (
      body.listedSlug !== undefined &&
      existingWorkflow.isListed === true &&
      existingWorkflow.listedSlug !== null &&
      body.listedSlug !== existingWorkflow.listedSlug
    ) {
      return NextResponse.json(
        { error: "This slug cannot be changed after listing. Create a new workflow if you need a different slug." },
        { status: 400 }
      );
    }

    const updateData = buildUpdateData(body);

    if (Array.isArray(updateData.nodes)) {
      // What these two gates do NOT do: prove the workflow will run.
      //
      // validateWorkflowIntegrations is an AUTHORIZATION check, not an
      // existence check - filterUnauthorizedIntegrationIds deliberately treats
      // ids with no matching row as authorized so stale references to deleted
      // integrations stay savable. A syntactically valid but wholly fictional
      // integrationId therefore passes and is persisted verbatim.
      //
      // Config values outside integrationId get less than that: `network` and
      // `actionType` are not checked against the chain registry or the action
      // catalogue on this path at all. Everything in data.config is stored as
      // opaque JSONB.
      //
      // So a 200 here means "you were allowed to save this", never "this
      // works". Misconfigured nodes surface only at execution time. Callers
      // driving the API directly (kh, MCP) should not read a successful
      // create or update as evidence that a workflow is functional.
      //
      // Validate the exact shape that will be persisted. The sanitizer moves
      // misplaced root fields into data.config, including integrationId.
      // Org principal: the workflow may only reference its owning org's
      // integrations, so the save gate matches the runtime credential fetch.
      const validation = await validateWorkflowIntegrations(
        updateData.nodes,
        existingWorkflow.organizationId
      );
      if (!validation.valid) {
        return NextResponse.json(
          { error: "Invalid integration references in workflow" },
          { status: 403 }
        );
      }

      const actionConfigValidation = validateWorkflowActionConfigs(
        updateData.nodes
      );
      if (!actionConfigValidation.valid) {
        return NextResponse.json(
          formatActionConfigValidationResponse(actionConfigValidation),
          { status: 422 }
        );
      }

      const featureGuard = await enforceWorkflowFeatures(
        extractActionTypeNodes(updateData.nodes),
        existingWorkflow.organizationId
      );
      if (featureGuard.blocked) {
        return featureGuard.response;
      }
    }

    // Set listedAt server-side on first listing (never from client, never cleared on unlist)
    if (body.isListed === true && existingWorkflow.listedAt === null) {
      updateData.listedAt = new Date();
    }

    // Re-run the publish-time gates from /listing/route.ts when this PATCH
    // either (a) edits a workflow that's already listed or (b) is the act of
    // listing it. This route is a backdoor around the dedicated listing
    // curator route — without these checks an author could publish a clean
    // workflow via /listing then PATCH `nodes` here to introduce a bare-@
    // literal, leaving a broken listing live in the bazaar.
    //
    // Field-touched-only semantics: stay backwards-compatible with workflows
    // listed before the gates existed by only validating the field the PATCH
    // actually changes. Legacy listings with null inputSchema continue to
    // work until the next edit that touches THAT field. The exception is a
    // fresh isListed=true transition through this route, which validates the
    // full final state (effectively a publish event).
    //
    // Unlist-and-clean-up bypass: a PATCH that explicitly sets isListed=false
    // is leaving the listed surface — the bazaar will never see the
    // post-patch state, so there's no value in blocking the user from fixing
    // a corrupted workflow on the way out. Skip the gates in that case.
    //
    // The 422 messages here intentionally diverge from the listing curator's
    // (app/api/mcp/workflows/[slug]/listing/route.ts:mapListingError) — they
    // include "or unlist the workflow before saving these changes" as
    // context-aware UX guidance. The curator-publish path has no such
    // option, so its messages don't mention unlisting.
    const isTransitioningToUnlisted =
      body.isListed === false && existingWorkflow.isListed === true;
    const isTransitioningToListed =
      body.isListed === true && existingWorkflow.isListed !== true;
    // Sharing is an explicit owner opt-in, so it has to be cleared on every
    // path that retires the surface it applies to - not just unlisting.
    // Demoting visibility to private already makes the share links 404
    // (isPubliclyShareableWorkflow requires public/unlisted), which reads to
    // the owner as "sharing is off"; leaving the column true meant a later
    // promotion back to public/unlisted silently re-exposed every historical
    // run, including ones from the private period, with no re-consent.
    const isTransitioningToPrivate =
      body.visibility === "private" && existingWorkflow.visibility !== "private";
    if (isTransitioningToUnlisted || isTransitioningToPrivate) {
      Object.assign(updateData, clearShareExecutionStatus());
    }

    // Enforce the sharing invariant against the visibility this request will
    // leave behind, not the one it started with, so `{visibility: "private",
    // shareExecutionStatus: true}` in a single PATCH is refused rather than
    // half-applied. Rejecting beats silently dropping the field: a caller that
    // is told nothing assumes sharing is on and hands out links that 404,
    // which is the failure this invariant exists to prevent.
    const effectiveVisibility = (body.visibility ??
      existingWorkflow.visibility) as string | null;
    if (
      body.shareExecutionStatus === true &&
      !canShareExecutionStatus(effectiveVisibility)
    ) {
      return NextResponse.json(
        {
          error: "SHARE_REQUIRES_PUBLIC_VISIBILITY",
          message:
            "Execution status can only be shared on a public or unlisted workflow. Change the workflow's visibility before enabling sharing.",
        },
        { status: 422 }
      );
    }
    const willBeListed =
      !isTransitioningToUnlisted &&
      (isTransitioningToListed || existingWorkflow.isListed === true);

    // `finalNodes` is `unknown` (updateData.nodes is unknown after the generic
    // Record cast). Both code paths actually hold an array — the body branch
    // went through `sanitizeWorkflowData`, the existing branch is `nodes`
    // declared `$type<any[]>` in lib/db/schema.ts. The cast is honest and
    // matches how lib/mcp/listing.ts calls the same function.
    const finalNodes =
      updateData.nodes !== undefined ? updateData.nodes : existingWorkflow.nodes;

    if (
      body.enabled === true &&
      hasDraftActionNodes(finalNodes as WorkflowNodeForValidation[])
    ) {
      return NextResponse.json(
        {
          error: "UNCONFIGURED_ACTION_NODES",
          message:
            "Workflow cannot be enabled while it contains unconfigured action nodes. Open the workflow editor and configure all action nodes before enabling.",
        },
        { status: 422 }
      );
    }

    // Auto-derive workflowType from content via the shared helper
    // (lib/mcp/calldata.ts::deriveWorkflowType). This intentionally replaces
    // the historical "workflowType is curator-only" model: a body's
    // `workflowType` is still dropped at the persistence layer (not in
    // `buildUpdateData`'s allowlist), so the requested type passed to the
    // helper is the row's current value. The curator listing path
    // (lib/mcp/listing.ts) calls the same helper for symmetry.
    const resolvedWorkflowType = deriveWorkflowType(
      finalNodes as unknown[],
      existingWorkflow.workflowType
    );
    const workflowTypeChanged =
      resolvedWorkflowType !== existingWorkflow.workflowType;
    if (workflowTypeChanged) {
      updateData.workflowType = resolvedWorkflowType;
    }

    if (willBeListed) {
      // A listed workflow must always carry a non-empty slug — external callers
      // invoke it by slug at /api/mcp/workflows/<slug>/call, so a listed-but-
      // slugless row is discoverable in the catalog yet uncallable. The curator
      // publish path enforces this (lib/mcp/listing.ts::listWorkflow); without
      // the same gate on this backdoor PATCH, a caller could list a workflow
      // with a null slug or strip the slug off one that is already listed.
      // Checked for any willBeListed state (not field-touched-only) because the
      // invariant holds regardless of which field the PATCH changed; unlisting
      // already makes willBeListed false, so a PATCH setting isListed=false is
      // exempt. Same error code as the curator route (SLUG_REQUIRED) so both
      // surfaces reject identically.
      const finalSlug =
        updateData.listedSlug !== undefined
          ? updateData.listedSlug
          : existingWorkflow.listedSlug;
      if (typeof finalSlug !== "string" || finalSlug.trim().length === 0) {
        return NextResponse.json(
          {
            error: "SLUG_REQUIRED",
            message:
              "Listed workflows must have a slug. Set a non-empty `listedSlug` (lowercase letters, numbers, and hyphens), or unlist the workflow before saving these changes.",
          },
          { status: 422 }
        );
      }
      // When the body sets the slug, persist the trimmed value so the stored
      // slug matches what was validated (no leading/trailing whitespace).
      if (updateData.listedSlug !== undefined) {
        updateData.listedSlug = finalSlug.trim();
      }

      const checkNodes =
        updateData.nodes !== undefined || isTransitioningToListed;
      const checkSchema =
        updateData.inputSchema !== undefined || isTransitioningToListed;
      const finalSchema =
        updateData.inputSchema !== undefined
          ? updateData.inputSchema
          : existingWorkflow.inputSchema;

      // Gate ordering matches the publish path (lib/mcp/listing.ts::listWorkflow):
      // write-action -> bare-@ -> input-schema. Same DB state therefore yields
      // the same error code regardless of which gate-bearing route the caller
      // hits, which keeps client-side error handling consistent. The gate uses
      // `existingWorkflow.workflowType` because the auto-flip above only flips
      // to "write" (never back to "read"), so a workflow that WAS write and
      // now has no write node still trips this guard correctly.
      if (
        checkNodes &&
        existingWorkflow.workflowType === "write" &&
        findFirstWriteActionNode(finalNodes as unknown[]) === undefined
      ) {
        return NextResponse.json(
          {
            error: "MISSING_WRITE_ACTION",
            message:
              "Workflows listed as workflowType='write' must contain at least one write-contract or protocol-write action node. Add the action back, or unlist the workflow before saving these changes.",
          },
          { status: 422 }
        );
      }

      if (checkNodes) {
        const literals = findBareAtLiterals(finalNodes);
        if (literals.length > 0) {
          return NextResponse.json(
            {
              error: "INVALID_TEMPLATE_LITERALS",
              message:
                "Listed workflow contains a bare `@<word>` literal in a node config field outside a `{{...}}` template wrapper. Replace it with a `{{@nodeId:Label.field}}` reference, or unlist the workflow before saving these changes.",
              literals,
            },
            { status: 422 }
          );
        }
      }
      if (checkSchema && !isInputSchemaPresent(finalSchema)) {
        return NextResponse.json(
          {
            error: "INPUT_SCHEMA_REQUIRED",
            message:
              'Listed workflows must declare an `inputSchema`. Set it to a JSON-schema-shaped object (`{"type": "object"}` is fine for workflows that take no inputs), or unlist the workflow before saving these changes.',
          },
          { status: 422 }
        );
      }
    }

    // Bump listingVersion when a listed (or about-to-be-listed) workflow has
    // its schema-defining fields changed via this route — including an
    // auto-flip of workflowType. Keeps per-workflow MCP consumers in sync
    // without a dedicated version endpoint.
    if (
      willBeListed &&
      (body.nodes !== undefined ||
        body.edges !== undefined ||
        body.inputSchema !== undefined ||
        body.outputMapping !== undefined ||
        workflowTypeChanged)
    ) {
      updateData.listingVersion = sql`${workflows.listingVersion} + 1`;
    }

    let updatedWorkflow: typeof workflows.$inferSelect;
    try {
      const [result] = await db
        .update(workflows)
        .set(updateData)
        .where(eq(workflows.id, workflowId))
        .returning();
      if (!result) {
        return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
      }
      updatedWorkflow = result;
    } catch (dbError) {
      const cause = dbError instanceof Error ? dbError.cause : undefined;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505") {
        return NextResponse.json(
          { error: "This slug is already in use. Choose a different slug." },
          { status: 400 }
        );
      }
      throw dbError;
    }

    await handlePostUpdateSideEffects(workflowId, body);

    // Resolve project/tag names so a move/tagging shows "Project: A -> B" in
    // the activity feed rather than opaque ids.
    const movementProjectIds = [
      existingWorkflow.projectId,
      updatedWorkflow.projectId,
    ].filter((v): v is string => Boolean(v));
    const movementTagIds = [
      existingWorkflow.tagId,
      updatedWorkflow.tagId,
    ].filter((v): v is string => Boolean(v));
    const [projectNameRows, tagNameRows] = await Promise.all([
      movementProjectIds.length > 0
        ? db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, movementProjectIds))
        : Promise.resolve([]),
      movementTagIds.length > 0
        ? db
            .select({ id: tags.id, name: tags.name })
            .from(tags)
            .where(inArray(tags.id, movementTagIds))
        : Promise.resolve([]),
    ]);
    const projectNameById = new Map(projectNameRows.map((r) => [r.id, r.name]));
    const tagNameById = new Map(tagNameRows.map((r) => [r.id, r.name]));
    const nameFor = (
      map: Map<string, string>,
      id: string | null
    ): string | null => (id ? (map.get(id) ?? null) : null);

    // Audit the change with scalar fields plus a content hash of the
    // definition, so the row stays small. The full nodes/edges snapshot and
    // structural diff are the job of the workflow change-history table.
    await recordAuditEvent({
      actor: {
        userId,
        organizationId,
        authMethod: authContext.authMethod,
        apiKeyId: authContext.apiKeyId,
      },
      action: "workflow.updated",
      resourceType: "workflow",
      resourceId: workflowId,
      before: {
        name: existingWorkflow.name,
        enabled: existingWorkflow.enabled,
        visibility: existingWorkflow.visibility,
        isListed: existingWorkflow.isListed,
        project: nameFor(projectNameById, existingWorkflow.projectId),
        tag: nameFor(tagNameById, existingWorkflow.tagId),
        contentHash: hashWorkflowDefinition(
          existingWorkflow.nodes,
          existingWorkflow.edges
        ),
      },
      after: {
        name: updatedWorkflow.name,
        enabled: updatedWorkflow.enabled,
        visibility: updatedWorkflow.visibility,
        isListed: updatedWorkflow.isListed,
        project: nameFor(projectNameById, updatedWorkflow.projectId),
        tag: nameFor(tagNameById, updatedWorkflow.tagId),
        contentHash: hashWorkflowDefinition(
          updatedWorkflow.nodes,
          updatedWorkflow.edges
        ),
      },
      metadata: buildAuditMetadata(request),
    });

    // Full version snapshot for the change-history timeline + restore.
    await recordWorkflowSnapshot({
      workflowId,
      before: existingWorkflow,
      after: updatedWorkflow,
      actor: { userId, organizationId, authMethod: authContext.authMethod },
      source: "update",
    });

    return NextResponse.json({
      ...updatedWorkflow,
      createdAt: updatedWorkflow.createdAt.toISOString(),
      updatedAt: updatedWorkflow.updatedAt.toISOString(),
      isOwner: true,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to update workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update workflow",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE);
    if (scopeError) {
      return scopeError;
    }

    const { userId, organizationId } = authContext;

    const { hasAccess } = await validateWorkflowAccess(
      workflowId,
      userId,
      organizationId,
      authContext.authMethod
    );

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Check for existing executions before deleting
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true";

    const hasExecutions = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.workflowId, workflowId),
      columns: { id: true },
    });

    if (hasExecutions && !force) {
      return NextResponse.json(
        {
          error:
            "Workflow has execution history. Delete executions first before deleting the workflow.",
          hasExecutions: true,
        },
        { status: 409 }
      );
    }

    // KEEP-440: soft-delete the workflow row instead of hard-deleting it. The
    // surviving row keeps its listedSlug bound in idx_workflows_listed_slug, so
    // the slug can never be re-claimed by another workflow. On force, the bulky
    // per-step logs are hard-deleted to reclaim storage but the execution runs
    // are soft-deleted (deleted_at) so usage counters, which count every row,
    // stay accurate; schedules are removed explicitly -- the ON DELETE CASCADE
    // that used to clean them up no longer fires now that the row is not
    // actually deleted.
    const softDelete = softDeleteValues();

    if (hasExecutions && force) {
      const { workflowExecutionLogs } = await import("@/lib/db/schema");
      const { inArray } = await import("drizzle-orm");

      await db.transaction(async (tx) => {
        const executions = await tx.query.workflowExecutions.findMany({
          where: eq(workflowExecutions.workflowId, workflowId),
          columns: { id: true },
        });

        const executionIds = executions.map((e) => e.id);

        if (executionIds.length > 0) {
          await tx
            .delete(workflowExecutionLogs)
            .where(inArray(workflowExecutionLogs.executionId, executionIds));

          await tx
            .update(workflowExecutions)
            .set({ deletedAt: new Date() })
            .where(eq(workflowExecutions.workflowId, workflowId));
        }

        await tx
          .delete(workflowSchedules)
          .where(eq(workflowSchedules.workflowId, workflowId));

        await tx
          .update(workflows)
          .set(softDelete)
          .where(eq(workflows.id, workflowId));
      });
    } else {
      await db.transaction(async (tx) => {
        await tx
          .delete(workflowSchedules)
          .where(eq(workflowSchedules.workflowId, workflowId));

        await tx
          .update(workflows)
          .set(softDelete)
          .where(eq(workflows.id, workflowId));
      });
    }

    await recordAuditEvent({
      actor: {
        userId,
        organizationId,
        authMethod: authContext.authMethod,
        apiKeyId: authContext.apiKeyId,
      },
      action: "workflow.deleted",
      resourceType: "workflow",
      resourceId: workflowId,
      metadata: { ...buildAuditMetadata(request), forced: force },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    // Handle FK constraint violation from race condition (execution inserted between check and delete)
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "23503") {
      return NextResponse.json(
        {
          error:
            "Workflow has execution history. Delete executions first before deleting the workflow.",
        },
        { status: 409 }
      );
    }

    logSystemError(ErrorCategory.DATABASE, "Failed to delete workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete workflow",
      },
      { status: 500 }
    );
  }
}
