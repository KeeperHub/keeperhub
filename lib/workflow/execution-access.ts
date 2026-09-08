import "server-only";

import { eq } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { db } from "@/lib/db";
import type { TransactionHashEntry } from "@/lib/db/schema";
import { workflowExecutions } from "@/lib/db/schema";
import type { NodeExecutionStatus } from "@/lib/errors/execution-status";
import {
  type DualAuthContext,
  getDualAuthContext,
  hasResolvedPrincipal,
} from "@/lib/middleware/auth-helpers";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { canShareExecutionStatus } from "@/lib/workflow/share-execution-status";

type AuthenticatedContext = Exclude<DualAuthContext, { error: string }>;

function loadExecutionWithWorkflow(executionId: string) {
  return db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    with: { workflow: true },
  });
}

export type AuthorizedExecution = NonNullable<
  Awaited<ReturnType<typeof loadExecutionWithWorkflow>>
>;

export type ExecutionAccessResult =
  | { ok: true; execution: AuthorizedExecution; auth: AuthenticatedContext }
  | { ok: false; status: number; error: string };

export type ExecutionViewAccess =
  | { mode: "full"; execution: AuthorizedExecution }
  | { mode: "publicReadOnly"; execution: AuthorizedExecution }
  | { mode: "accessDenied" }
  | { mode: "invalidAuth"; error: string }
  | { mode: "notFound" };

type NodeStatus = {
  nodeId: string;
  status: NodeExecutionStatus;
};

export type ExecutionStatusPayload = {
  status: string;
  nodeStatuses: NodeStatus[];
  progress: {
    totalSteps: number;
    completedSteps: number;
    runningSteps: number;
    currentNodeId: string | null;
    currentNodeName: string | null;
    percentage: number;
  };
  errorContext: {
    failedNodeId: string | null;
    lastSuccessfulNodeId: string | null;
    lastSuccessfulNodeName: string | null;
    executionTrace?: string[] | null;
    error?: string | null;
  } | null;
  transactionHashes: TransactionHashEntry[];
};

function isPubliclyShareableWorkflow(
  workflow: AuthorizedExecution["workflow"]
): boolean {
  if (workflow.deletedAt) {
    return false;
  }
  if (!workflow.shareExecutionStatus) {
    return false;
  }
  return canShareExecutionStatus(workflow.visibility);
}

/**
 * A caller that presented a Bearer credential which did not authenticate gets
 * 401, not the anonymous 404. Covers OAuth access tokens as well as `kh_` API
 * keys: `getDualAuthContext(..., { required: false })` degrades either failure
 * to a null principal, so without this an expired MCP token looked identical
 * to "no such execution" and the client had no signal to run its refresh flow.
 *
 * Takes the already-resolved context so the happy path costs one auth
 * resolution; authenticateApiKey is re-run only on the failure path, purely to
 * recover the specific reason ("expired", "revoked", bad format) for the
 * response body.
 */
async function resolveInvalidBearerAuth(
  request: Request,
  authContext: DualAuthContext
): Promise<{ mode: "invalidAuth"; error: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  if (hasResolvedPrincipal(authContext)) {
    return null;
  }
  if ("error" in authContext) {
    // A session-shaped failure (MFA step-up, org resolution) keeps the
    // established collapse to 404; it is not a bad Bearer.
    return null;
  }
  if (authHeader.startsWith("Bearer kh_")) {
    const apiKeyAuth = await authenticateApiKey(request);
    if (apiKeyAuth.authenticated) {
      return null;
    }
    return { mode: "invalidAuth", error: apiKeyAuth.error ?? "Unauthorized" };
  }
  return { mode: "invalidAuth", error: "Invalid or expired access token" };
}

/**
 * Strip verbose internals from status payloads served to unauthenticated
 * viewers of opted-in public/unlisted workflow executions.
 */
export function redactExecutionStatusForPublicView(
  payload: ExecutionStatusPayload
): ExecutionStatusPayload {
  const redactedNodeStatuses = payload.nodeStatuses.map((node) => ({
    status: node.status,
    nodeId: "",
  }));

  return {
    ...payload,
    nodeStatuses: redactedNodeStatuses,
    progress: {
      ...payload.progress,
      currentNodeId: null,
      currentNodeName: null,
    },
    errorContext: payload.errorContext
      ? {
          failedNodeId: null,
          lastSuccessfulNodeId: null,
          lastSuccessfulNodeName: null,
        }
      : null,
    // Explicit allowlist rather than a spread + override: hash and chainId
    // are the only fields the public share view renders (the tx link and
    // its explorer). nodeId/nodeName identify internal workflow steps;
    // network/iterationIndex/verified/receiptStatus are internal execution
    // detail with no current public consumer. Blanking by name (as this
    // used to do for nodeName only) leaks a new TransactionHashEntry field
    // by default; allowlisting requires an explicit decision to expose one.
    transactionHashes: payload.transactionHashes.map((entry) => ({
      hash: entry.hash,
      chainId: entry.chainId,
      nodeId: "",
      nodeName: "",
    })),
  };
}

/**
 * Resolve how a caller may view an execution: full org access, public read-only
 * (opted-in public/unlisted workflow), access denied (a member of the owning
 * org whose access is blocked for another reason), invalid auth (a Bearer
 * credential that did not authenticate), or not found (unknown id, or an
 * execution the caller has no relationship to — anti-enumeration).
 *
 * Pass `authContext` when the caller has already resolved it (the status route
 * needs it for rate limiting) so a single request does not resolve auth twice.
 */
export async function resolveExecutionViewAccess(
  request: Request,
  executionId: string,
  authContext?: DualAuthContext
): Promise<ExecutionViewAccess> {
  const auth =
    authContext ?? (await getDualAuthContext(request, { required: false }));

  const invalidBearer = await resolveInvalidBearerAuth(request, auth);
  if (invalidBearer) {
    return invalidBearer;
  }

  const execution = await loadExecutionWithWorkflow(executionId);
  if (!execution) {
    return { mode: "notFound" };
  }

  if ("error" in auth) {
    return { mode: "notFound" };
  }

  const access = hasResolvedPrincipal(auth)
    ? await getWorkflowAccess(execution.workflow, {
        userId: auth.userId,
        organizationId: auth.organizationId,
        authMethod: auth.authMethod,
      })
    : null;

  if (access?.hasFullAccess && !access.isDeleted) {
    return { mode: "full", execution };
  }

  if (isPubliclyShareableWorkflow(execution.workflow)) {
    return { mode: "publicReadOnly", execution };
  }

  // 403 only for a caller who is in the owning org and therefore already knows
  // this execution exists (today: the workflow was soft-deleted). Anyone else -
  // signed in or not - gets the same 404 a fabricated id gets. Distinguishing
  // "real execution, not yours" from "no such execution" would hand any account
  // holder an oracle over scraped execution ids, which is exactly the collapse
  // resolveAuthorizedExecution has always made for the logs and wait routes.
  if (access?.isSameOrg) {
    return { mode: "accessDenied" };
  }

  return { mode: "notFound" };
}

/**
 * Authenticate the request, load the execution, and verify the caller may see
 * it. Shared by the logs and wait endpoints so they apply identical auth and
 * soft-delete rules. A soft-deleted workflow hides its executions, so those
 * collapse to 404 rather than leaking existence.
 */
export async function resolveAuthorizedExecution(
  request: Request,
  executionId: string
): Promise<ExecutionAccessResult> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return { ok: false, status: authContext.status, error: authContext.error };
  }

  const { userId, organizationId } = authContext;
  if (!(userId || organizationId)) {
    return {
      ok: false,
      status: 403,
      error:
        "API key has no associated user or organization. Please recreate the API key.",
    };
  }

  const execution = await loadExecutionWithWorkflow(executionId);
  if (!execution) {
    return { ok: false, status: 404, error: "Execution not found" };
  }

  const access = await getWorkflowAccess(execution.workflow, {
    userId,
    organizationId,
    authMethod: authContext.authMethod,
  });
  if (!access.hasFullAccess || access.isDeleted) {
    return { ok: false, status: 404, error: "Execution not found" };
  }

  return { ok: true, execution, auth: authContext };
}
