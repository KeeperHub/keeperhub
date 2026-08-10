import { and, eq, sql } from "drizzle-orm";
import { classifyChainTag } from "@/lib/agentic-wallet/workflow-binding";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import {
  deriveWorkflowType,
  findFirstWriteActionNode,
} from "@/lib/mcp/calldata";
import {
  findBareAtLiterals,
  isInputSchemaPresent,
} from "@/lib/mcp/listing-validators";
import {
  canShareExecutionStatus,
  clearShareExecutionStatus,
  shareExecutionStatusUpdate,
} from "@/lib/workflow/share-execution-status";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

export type ListingErrorCode =
  | "NOT_FOUND"
  | "SLUG_CONFLICT"
  | "PRICE_CHANGE_WHILE_LISTED"
  | "INVALID_INPUT"
  | "SLUG_REQUIRED"
  | "MISSING_WRITE_ACTION"
  | "INVALID_TEMPLATE_LITERALS"
  | "INPUT_SCHEMA_REQUIRED"
  | "INVALID_CHAIN"
  | "SHARE_REQUIRES_PUBLIC_VISIBILITY";

export interface ListingErrorDetails {
  // Bare-@ literals found in node configs at publish time, surfaced so the
  // author can locate the offending field without spelunking. Capped at
  // MAX_FINDINGS by the validator.
  literals?: string[];
  // The unrecognised chain value, for INVALID_CHAIN.
  chain?: string;
}

/**
 * Reject a chain tag classifyChainTag cannot place in payment, data, or
 * multi. Without this, an unrecognised value (typo, disabled chain,
 * unsupported chain) persists silently and only surfaces as
 * 403 CHAIN_MISMATCH at the first payment attempt, months after listing.
 */
async function validateChainTag(chain: string | undefined): Promise<{
  ok: false;
  error: "INVALID_CHAIN";
  details: { chain: string };
} | null> {
  // An empty (or whitespace-only) chain is how a caller clears the pin, not a
  // tag to classify. workflows.chain is read as falsy by verifyWorkflowBinding,
  // so a cleared value is permissive exactly like the null it replaces -- and
  // rejecting it here would leave a mis-tagged listing with no way back.
  if (chain === undefined || chain.trim() === "") {
    return null;
  }
  const classification = await classifyChainTag(chain);
  if (classification.kind === "unrecognised") {
    return { ok: false, error: "INVALID_CHAIN", details: { chain } };
  }
  return null;
}

export type ListingResult<T> =
  | { ok: true; listing: T }
  | { ok: false; error: ListingErrorCode; details?: ListingErrorDetails };

export interface ListWorkflowMetadata {
  slug?: string;
  category?: string;
  chain?: string;
  inputSchema?: Record<string, unknown>;
  outputMapping?: Record<string, unknown>;
  workflowType?: string;
  shareExecutionStatus?: boolean;
}

export interface UpdateWorkflowPatch {
  category?: string;
  chain?: string;
  inputSchema?: Record<string, unknown>;
  outputMapping?: Record<string, unknown>;
  workflowType?: string;
  priceUsdcPerCall?: string;
}

const LISTING_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  listedAt: workflows.listedAt,
  inputSchema: workflows.inputSchema,
  outputMapping: workflows.outputMapping,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  organizationId: workflows.organizationId,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
  isListed: workflows.isListed,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
  listingVersion: workflows.listingVersion,
  nodes: workflows.nodes,
};

// Public projection: LISTING_COLUMNS minus `nodes`. The public,
// unauthenticated GET /api/mcp/workflows/[slug]/listing endpoint (and the
// HTTP-proxied get_workflow_listing MCP tool) must never return workflow node
// internals (contract addresses, webhook URLs, raw calldata) to anonymous
// callers. Maintained as an explicit allowlist mirroring LISTED_WORKFLOW_COLUMNS
// (app/api/mcp/workflows/route.ts) -- NOT a runtime Omit -- so a future column
// added to LISTING_COLUMNS does not auto-leak through this surface.
const PUBLIC_LISTING_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  listedAt: workflows.listedAt,
  inputSchema: workflows.inputSchema,
  outputMapping: workflows.outputMapping,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  organizationId: workflows.organizationId,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
  isListed: workflows.isListed,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
  listingVersion: workflows.listingVersion,
};

type ListingRow = {
  id: string;
  name: string;
  description: string | null;
  listedSlug: string | null;
  listedAt: Date | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  organizationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  isListed: boolean;
  workflowType: "read" | "write";
  category: string | null;
  chain: string | null;
  listingVersion: number;
  nodes: unknown[];
};

function isSlugConflict(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code === "23505";
}

export async function listWorkflow(
  workflowId: string,
  orgId: string,
  metadata: ListWorkflowMetadata = {}
): Promise<ListingResult<typeof workflows.$inferSelect>> {
  const existing = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.organizationId, orgId),
        workflowNotDeleted()
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const current = existing[0];

  const updateSet: Partial<typeof workflows.$inferInsert> & {
    updatedAt: Date;
    listedAt: Date;
    isListed: boolean;
  } = {
    isListed: true,
    listedAt: new Date(),
    updatedAt: new Date(),
  };

  if (current.listedSlug === null) {
    // Trim before validating and persisting so a blank/whitespace slug is
    // refused (not stored as an uncallable listing) and the stored value
    // matches what the PATCH route's gate (which trims) would accept.
    const slug = metadata.slug?.trim();
    if (!slug) {
      return { ok: false, error: "SLUG_REQUIRED" };
    }
    updateSet.listedSlug = slug;
  }
  // If listedSlug is already set, do not overwrite it (slug is sticky)

  if (metadata.category !== undefined) {
    updateSet.category = metadata.category;
  }
  if (metadata.chain !== undefined) {
    const chainError = await validateChainTag(metadata.chain);
    if (chainError) {
      return chainError;
    }
    updateSet.chain = metadata.chain;
  }
  if (metadata.inputSchema !== undefined) {
    updateSet.inputSchema = metadata.inputSchema;
  }
  if (metadata.shareExecutionStatus !== undefined) {
    // Listing a workflow does not make it public - visibility is a separate
    // axis this API never writes - so a curator enabling sharing on a private
    // workflow would persist a flag the read gate refuses, and hand out links
    // that 404 with a 200 to say it worked.
    if (
      metadata.shareExecutionStatus &&
      !canShareExecutionStatus(current.visibility)
    ) {
      return { ok: false, error: "SHARE_REQUIRES_PUBLIC_VISIBILITY" };
    }
    Object.assign(
      updateSet,
      shareExecutionStatusUpdate(metadata.shareExecutionStatus)
    );
  }
  if (metadata.outputMapping !== undefined) {
    updateSet.outputMapping = metadata.outputMapping;
  }
  // Auto-derive workflowType from content via the shared helper
  // (lib/mcp/calldata.ts::deriveWorkflowType). A callable write node forces
  // "write" and overrides a curator-supplied "read" that conflicts with
  // the content.
  const requestedWorkflowType: "read" | "write" =
    (metadata.workflowType as "read" | "write" | undefined) ??
    current.workflowType;
  const resolvedWorkflowType = deriveWorkflowType(
    current.nodes,
    requestedWorkflowType
  );
  updateSet.workflowType = resolvedWorkflowType;

  // Bump listingVersion whenever we are transitioning to listed OR whenever
  // any of the schema-defining fields changes on an already-listed workflow.
  const isSchemaTouched =
    metadata.inputSchema !== undefined ||
    metadata.outputMapping !== undefined ||
    resolvedWorkflowType !== current.workflowType;
  if (!current.isListed || isSchemaTouched) {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle sql template tag produces a typed SQL expression that satisfies the column type at runtime
    (updateSet as any).listingVersion = sql`${workflows.listingVersion} + 1`;
  }

  // A "write" workflow must contain a calldata-generatable write node;
  // otherwise call_workflow would later fail at runtime with "No write action
  // node found in workflow". With auto-derive above, this can only trigger when
  // a curator forces "write" on content that has no callable write node.
  if (
    resolvedWorkflowType === "write" &&
    findFirstWriteActionNode(current.nodes) === undefined
  ) {
    return { ok: false, error: "MISSING_WRITE_ACTION" };
  }

  // Reject bare-@ literals in node configs. These are the trapped state of the
  // editor's `@` autocomplete (user typed `@40` and dismissed the picker before
  // it wrapped the reference into `{{@nodeId:Label.field}}`). The executor only
  // resolves wrapped templates, so an unwrapped `@40` would silently flow
  // through as a literal at runtime. Surface the offending literals so the
  // author can locate the field without spelunking.
  const bareLiterals = findBareAtLiterals(current.nodes);
  if (bareLiterals.length > 0) {
    return {
      ok: false,
      error: "INVALID_TEMPLATE_LITERALS",
      details: { literals: bareLiterals },
    };
  }

  // Listed workflows must declare an inputSchema. Bazaar consumers (agentcash,
  // x402scan, the OpenAPI spec) need a JSON-schema-shaped object to render and
  // validate inputs; an empty `{type: "object"}` is fine for zero-input
  // workflows. Allowing null at publish time leaves the listing unrenderable.
  const finalInputSchema = updateSet.inputSchema ?? current.inputSchema;
  if (!isInputSchemaPresent(finalInputSchema)) {
    return { ok: false, error: "INPUT_SCHEMA_REQUIRED" };
  }

  try {
    const [result] = await db
      .update(workflows)
      .set(updateSet)
      .where(
        and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId))
      )
      .returning();
    if (!result) {
      return { ok: false, error: "NOT_FOUND" };
    }
    return { ok: true, listing: result };
  } catch (err) {
    if (isSlugConflict(err)) {
      return { ok: false, error: "SLUG_CONFLICT" };
    }
    throw err;
  }
}

export async function unlistWorkflow(
  workflowId: string,
  orgId: string
): Promise<ListingResult<typeof workflows.$inferSelect>> {
  const existing = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.organizationId, orgId),
        workflowNotDeleted()
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const [result] = await db
    .update(workflows)
    .set({
      ...clearShareExecutionStatus(),
      isListed: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.organizationId, orgId),
        workflowNotDeleted()
      )
    )
    .returning();

  if (!result) {
    return { ok: false, error: "NOT_FOUND" };
  }

  return { ok: true, listing: result };
}

export async function updateWorkflowListing(
  workflowId: string,
  orgId: string,
  patch: UpdateWorkflowPatch
): Promise<ListingResult<typeof workflows.$inferSelect>> {
  const existing = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.organizationId, orgId),
        workflowNotDeleted()
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const current = existing[0];

  if (patch.priceUsdcPerCall !== undefined && current.isListed === true) {
    return { ok: false, error: "PRICE_CHANGE_WHILE_LISTED" };
  }

  const updateSet: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.category !== undefined) {
    updateSet.category = patch.category;
  }
  if (patch.chain !== undefined) {
    const chainError = await validateChainTag(patch.chain);
    if (chainError) {
      return chainError;
    }
    updateSet.chain = patch.chain;
  }
  if (patch.inputSchema !== undefined) {
    updateSet.inputSchema = patch.inputSchema;
  }
  if (patch.outputMapping !== undefined) {
    updateSet.outputMapping = patch.outputMapping;
  }
  // Auto-derive workflowType from content via the shared helper
  // (lib/mcp/calldata.ts::deriveWorkflowType). See listWorkflow for rationale.
  const requestedWorkflowType: "read" | "write" =
    (patch.workflowType as "read" | "write" | undefined) ??
    current.workflowType;
  const resolvedWorkflowType = deriveWorkflowType(
    current.nodes,
    requestedWorkflowType
  );
  const workflowTypeChanged = resolvedWorkflowType !== current.workflowType;
  if (patch.workflowType !== undefined || workflowTypeChanged) {
    updateSet.workflowType = resolvedWorkflowType;
  }
  if (patch.priceUsdcPerCall !== undefined) {
    // Only reachable when isListed === false (price-change-while-listed guard above)
    updateSet.priceUsdcPerCall = patch.priceUsdcPerCall;
  }

  // Bump listingVersion when schema-defining fields change on a listed workflow
  // so per-workflow MCP consumers can detect stale tool definitions.
  const isUpdateSchemaTouched =
    patch.inputSchema !== undefined ||
    patch.outputMapping !== undefined ||
    workflowTypeChanged;
  if (current.isListed && isUpdateSchemaTouched) {
    updateSet.listingVersion = sql`${workflows.listingVersion} + 1`;
  }

  // Same write-workflow guard as listWorkflow: a listed "write" must contain a
  // calldata-generatable write node. An unlisted draft may still carry a "write"
  // type without one. resolvedWorkflowType already reflects the auto-derive.
  if (
    current.isListed === true &&
    resolvedWorkflowType === "write" &&
    findFirstWriteActionNode(current.nodes) === undefined
  ) {
    return { ok: false, error: "MISSING_WRITE_ACTION" };
  }

  // Defense in depth: if the listed workflow's nodes were corrupted via an
  // out-of-band path (e.g. a script or an admin tool that bypassed the
  // /api/workflows/[workflowId] PATCH gate), refuse to apply curator-side
  // metadata changes that would re-emphasize a broken listing. Same gate as
  // the publish path. Only runs when the row is (or stays) listed.
  //
  // Asymmetry note: the workflows-PATCH route uses field-touched-only
  // semantics (only validates a field when the PATCH actually changes it,
  // for backwards-compat with legacy listings). This curator path is
  // intentionally STRICTER — every metadata change re-checks the full state
  // unconditionally. Rationale: a corrupted listing should not receive
  // metadata refreshes (category/chain/price etc.) that re-emphasize it on
  // the bazaar surface. Authors of legacy null-inputSchema or bad-nodes
  // listings must self-heal via the workflow editor before metadata edits
  // land here.
  if (current.isListed === true) {
    const literals = findBareAtLiterals(current.nodes);
    if (literals.length > 0) {
      return {
        ok: false,
        error: "INVALID_TEMPLATE_LITERALS",
        details: { literals },
      };
    }
    const finalInputSchema =
      patch.inputSchema === undefined ? current.inputSchema : patch.inputSchema;
    if (!isInputSchemaPresent(finalInputSchema)) {
      return { ok: false, error: "INPUT_SCHEMA_REQUIRED" };
    }
  }

  try {
    const [result] = await db
      .update(workflows)
      .set(updateSet)
      .where(
        and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId))
      )
      .returning();

    if (!result) {
      return { ok: false, error: "NOT_FOUND" };
    }
    return { ok: true, listing: result };
  } catch (err) {
    if (isSlugConflict(err)) {
      return { ok: false, error: "SLUG_CONFLICT" };
    }
    throw err;
  }
}

export async function getWorkflowListing(
  slug: string
): Promise<ListingResult<ListingRow>> {
  // Public read: only return currently-listed workflows. Unlisting preserves
  // listedSlug (sticky-slug behavior on relist), so filtering by slug alone
  // would leak unlisted workflows' metadata after the unlist. The public
  // catalog at GET /api/mcp/workflows enforces the same invariant.
  const rows = await db
    .select(LISTING_COLUMNS)
    .from(workflows)
    .where(
      and(
        eq(workflows.listedSlug, slug),
        eq(workflows.isListed, true),
        workflowNotDeleted()
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  return { ok: true, listing: rows[0] as ListingRow };
}

export async function getWorkflowListingPublic(
  slug: string
): Promise<ListingResult<Omit<ListingRow, "nodes">>> {
  // Unauthenticated public read. Runs the IDENTICAL query as getWorkflowListing
  // (listedSlug + isListed=true + not-deleted, limit 1) but projects
  // PUBLIC_LISTING_COLUMNS so workflow `nodes` are never returned. The
  // authenticated per-workflow MCP server keeps using getWorkflowListing because
  // it needs nodes for trigger detection.
  const rows = await db
    .select(PUBLIC_LISTING_COLUMNS)
    .from(workflows)
    .where(
      and(
        eq(workflows.listedSlug, slug),
        eq(workflows.isListed, true),
        workflowNotDeleted()
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  return { ok: true, listing: rows[0] as Omit<ListingRow, "nodes"> };
}
