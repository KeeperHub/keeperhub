import { NextResponse } from "next/server";
import { HttpStatus } from "@/lib/http-status";
import {
  getWorkflowListingPublic,
  type ListingErrorDetails,
  type ListWorkflowMetadata,
  listWorkflow,
  type UpdateWorkflowPatch,
  unlistWorkflow,
  updateWorkflowListing,
} from "@/lib/mcp/listing";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { sanitizeDescription } from "@/lib/sanitize-description";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

const LISTING_RATE_LIMIT = 60;
const LISTING_RATE_WINDOW_MS = 60_000;

type RouteContext = { params: Promise<{ slug: string }> };

function mapListingError(
  error: string,
  details?: ListingErrorDetails
): NextResponse {
  if (error === "NOT_FOUND") {
    return NextResponse.json(
      { error: "Workflow not found" },
      { status: HttpStatus.NOT_FOUND }
    );
  }
  if (error === "SLUG_CONFLICT") {
    return NextResponse.json(
      {
        error: "SLUG_CONFLICT",
        message: "This slug is already in use by another listed workflow.",
      },
      { status: HttpStatus.CONFLICT }
    );
  }
  if (error === "PRICE_CHANGE_WHILE_LISTED") {
    return NextResponse.json(
      {
        error: "PRICE_CHANGE_WHILE_LISTED",
        message: "Unlist the workflow before changing the price.",
      },
      { status: HttpStatus.CONFLICT }
    );
  }
  if (error === "SLUG_REQUIRED") {
    return NextResponse.json(
      {
        error: "SLUG_REQUIRED",
        message:
          "Listed workflows must have a slug. Provide a non-empty `slug` (lowercase letters, numbers, and hyphens) to list this workflow.",
      },
      { status: HttpStatus.UNPROCESSABLE_ENTITY }
    );
  }
  if (error === "MISSING_WRITE_ACTION") {
    return NextResponse.json(
      {
        error: "MISSING_WRITE_ACTION",
        message:
          "Workflows listed as workflowType='write' must contain at least one write-contract or protocol-write action node. Add the action to the workflow before listing it.",
      },
      { status: HttpStatus.UNPROCESSABLE_ENTITY }
    );
  }
  if (error === "INVALID_TEMPLATE_LITERALS") {
    return NextResponse.json(
      {
        error: "INVALID_TEMPLATE_LITERALS",
        message:
          "One or more node config fields contain a bare `@<word>` literal outside a `{{...}}` template wrapper. This usually means the editor's `@` autocomplete was dismissed before the reference was completed. Re-open the workflow, replace the literal with a proper `{{@nodeId:Label.field}}` reference, and try listing again.",
        ...(details?.literals && details.literals.length > 0
          ? { literals: details.literals }
          : {}),
      },
      { status: HttpStatus.UNPROCESSABLE_ENTITY }
    );
  }
  if (error === "INPUT_SCHEMA_REQUIRED") {
    return NextResponse.json(
      {
        error: "INPUT_SCHEMA_REQUIRED",
        message:
          'Listed workflows must declare an `inputSchema`. Set it to a JSON-schema-shaped object (`{"type": "object"}` is fine for workflows that take no inputs).',
      },
      { status: HttpStatus.UNPROCESSABLE_ENTITY }
    );
  }
  if (error === "SHARE_REQUIRES_PUBLIC_VISIBILITY") {
    return NextResponse.json(
      {
        error: "SHARE_REQUIRES_PUBLIC_VISIBILITY",
        message:
          "Execution status can only be shared on a public or unlisted workflow. Listing a workflow does not change its visibility - set the workflow to public or unlisted first.",
      },
      { status: HttpStatus.UNPROCESSABLE_ENTITY }
    );
  }
  if (error === "INVALID_CHAIN") {
    return NextResponse.json(
      {
        error: "INVALID_CHAIN",
        message: `Chain "${details?.chain}" is not a recognised payment or data chain. Use a supported chain id, its slug (e.g. "ethereum", "polygon"), "base", "tempo", or an explicit multi-chain tag (e.g. "multi-chain").`,
      },
      { status: HttpStatus.UNPROCESSABLE_ENTITY }
    );
  }
  return NextResponse.json(
    { error: "INVALID_INPUT", message: "Invalid request." },
    { status: HttpStatus.BAD_REQUEST }
  );
}

// GET — public read by listedSlug. The `slug` URL segment is the listed slug.
export async function GET(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = checkIpRateLimit(
      clientIp,
      LISTING_RATE_LIMIT,
      LISTING_RATE_WINDOW_MS
    );
    if (!rateCheck.allowed) {
      return applyRateLimitHeaders(
        NextResponse.json(
          { error: "Too many requests" },
          { status: HttpStatus.TOO_MANY_REQUESTS }
        ),
        rateCheck
      );
    }

    const { slug } = await params;
    // Public, unauthenticated read: project the nodes-free listing so workflow
    // internals (contract addresses, webhook URLs, calldata) never leak.
    const result = await getWorkflowListingPublic(slug);

    if (!result.ok) {
      return NextResponse.json(
        { error: "Listing not found" },
        { status: HttpStatus.NOT_FOUND }
      );
    }

    const listing = {
      ...result.listing,
      description: result.listing.description
        ? sanitizeDescription(result.listing.description)
        : null,
    };

    return applyRateLimitHeaders(
      NextResponse.json(listing, {
        headers: {
          "Cache-Control": "public, max-age=60",
        },
      }),
      rateCheck
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}

// POST/PATCH/DELETE — curator mutations. The `slug` URL segment is the workflowId.
// Named `slug` in the route file because the parent directory `[slug]` must use
// a single param name across siblings (Next.js constraint, shared with [slug]/call).

export async function POST(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
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

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Organization required" },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  const { slug: workflowId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const rawBody = body as Record<string, unknown>;
  const metadata: ListWorkflowMetadata = {
    slug: typeof rawBody.slug === "string" ? rawBody.slug : undefined,
    category:
      typeof rawBody.category === "string" ? rawBody.category : undefined,
    chain: typeof rawBody.chain === "string" ? rawBody.chain : undefined,
    inputSchema:
      rawBody.inputSchema !== null && typeof rawBody.inputSchema === "object"
        ? (rawBody.inputSchema as Record<string, unknown>)
        : undefined,
    outputMapping:
      rawBody.outputMapping !== null &&
      typeof rawBody.outputMapping === "object"
        ? (rawBody.outputMapping as Record<string, unknown>)
        : undefined,
    workflowType:
      typeof rawBody.workflowType === "string"
        ? rawBody.workflowType
        : undefined,
    shareExecutionStatus:
      typeof rawBody.shareExecutionStatus === "boolean"
        ? rawBody.shareExecutionStatus
        : undefined,
  };

  const result = await listWorkflow(workflowId, organizationId, metadata);
  if (!result.ok) {
    return mapListingError(result.error, result.details);
  }

  await recordAuditEvent({
    actor: {
      userId: authContext.userId,
      organizationId,
      authMethod: authContext.authMethod,
      apiKeyId: authContext.apiKeyId,
    },
    action: "workflow.listed",
    resourceType: "workflow",
    resourceId: workflowId,
    after: { slug: result.listing.listedSlug },
    metadata: buildAuditMetadata(request),
  });

  return NextResponse.json(result.listing, { status: HttpStatus.OK });
}

export async function PATCH(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
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

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Organization required" },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  const { slug: workflowId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const rawBody = body as Record<string, unknown>;
  const patch: UpdateWorkflowPatch = {
    category:
      typeof rawBody.category === "string" ? rawBody.category : undefined,
    chain: typeof rawBody.chain === "string" ? rawBody.chain : undefined,
    inputSchema:
      rawBody.inputSchema !== null && typeof rawBody.inputSchema === "object"
        ? (rawBody.inputSchema as Record<string, unknown>)
        : undefined,
    outputMapping:
      rawBody.outputMapping !== null &&
      typeof rawBody.outputMapping === "object"
        ? (rawBody.outputMapping as Record<string, unknown>)
        : undefined,
    workflowType:
      typeof rawBody.workflowType === "string"
        ? rawBody.workflowType
        : undefined,
    priceUsdcPerCall:
      typeof rawBody.priceUsdcPerCall === "string"
        ? rawBody.priceUsdcPerCall
        : undefined,
  };

  const result = await updateWorkflowListing(workflowId, organizationId, patch);
  if (!result.ok) {
    return mapListingError(result.error, result.details);
  }

  await recordAuditEvent({
    actor: {
      userId: authContext.userId,
      organizationId,
      authMethod: authContext.authMethod,
      apiKeyId: authContext.apiKeyId,
    },
    action: "workflow.listing_updated",
    resourceType: "workflow",
    resourceId: workflowId,
    metadata: buildAuditMetadata(request),
  });

  return NextResponse.json(result.listing, { status: HttpStatus.OK });
}

export async function DELETE(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
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

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Organization required" },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  const { slug: workflowId } = await params;

  const result = await unlistWorkflow(workflowId, organizationId);
  if (!result.ok) {
    return mapListingError(result.error, result.details);
  }

  await recordAuditEvent({
    actor: {
      userId: authContext.userId,
      organizationId,
      authMethod: authContext.authMethod,
      apiKeyId: authContext.apiKeyId,
    },
    action: "workflow.unlisted",
    resourceType: "workflow",
    resourceId: workflowId,
    metadata: buildAuditMetadata(request),
  });

  return NextResponse.json(result.listing, { status: HttpStatus.OK });
}
