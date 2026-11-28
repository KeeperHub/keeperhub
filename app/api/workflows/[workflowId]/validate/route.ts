import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chains, workflows } from "@/lib/db/schema";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import {
  type ValidationResult,
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import { VALIDATION_ERROR_CODES } from "@/lib/mcp/validate-workflow-codes";
import { validateWorkflowDeep } from "@/lib/mcp/validate-workflow-deep";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { resolveProtocolEventAddress } from "@/lib/workflow/protocol-event-address";
import type { WorkflowNodeForValidation } from "@/lib/workflow/validation/action-config";
import { validateSendModeForSave } from "@/lib/workflow/validation/send-mode";

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  const { workflowId } = await context.params;

  const authContext = await getDualAuthContext(request, { required: true });
  if ("error" in authContext) {
    return NextResponse.json(
      { ok: false, error: authContext.error },
      { status: authContext.status }
    );
  }

  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const row = rows[0];

  const access = await getWorkflowAccess(row, {
    userId: authContext.userId,
    organizationId: authContext.organizationId,
    authMethod: authContext.authMethod,
  });

  if (access.isDeleted) {
    return NextResponse.json({ ok: false, error: "GONE" }, { status: 410 });
  }

  if (!access.hasFullAccess) {
    return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const deepCheck = searchParams.get("deepCheck") === "true";

  // Pre-fetch enabled chain rows ONCE per request — validator stays pure.
  // default_primary_wss rides along on the query that was already being made:
  // an Event trigger on a chain without a WebSocket endpoint is never
  // registered, and that is the one condition a user cannot self-diagnose.
  const enabledChainRows = await db
    .select({
      chainId: chains.chainId,
      defaultPrimaryWss: chains.defaultPrimaryWss,
    })
    .from(chains)
    .where(eq(chains.isEnabled, true));
  const chainIds = new Set(enabledChainRows.map((r) => r.chainId));
  const chainWebsockets = new Map(
    enabledChainRows.map((r) => [r.chainId, r.defaultPrimaryWss])
  );

  const workflow: ValidatorWorkflow = {
    id: row.id,
    // biome-ignore lint/suspicious/noExplicitAny: schema column is typed as any[]
    nodes: (row.nodes ?? []) as any[],
    // biome-ignore lint/suspicious/noExplicitAny: schema column is typed as any[]
    edges: (row.edges ?? []) as any[],
    inputSchema: (row.inputSchema ?? null) as Record<string, unknown> | null,
    outputMapping: (row.outputMapping ?? null) as Record<string, unknown> | null,
    isListed: row.isListed,
    workflowType: (row.workflowType ?? "read") as "read" | "write",
  };

  const options = {
    chainIds,
    chainWebsockets,
    resolveProtocolEventAddress,
  };
  const result: ValidationResult = deepCheck
    ? await validateWorkflowDeep(workflow, options)
    : validateWorkflow(workflow, options);

  // The Send as checks a save runs on these stored steps: bundle steps are
  // rechecked by the run-time rules, the others keep the saved-step exemption.
  const nodes = workflow.nodes as WorkflowNodeForValidation[];
  const sendModes = await validateSendModeForSave(nodes, {
    savedNodes: nodes,
    recheckBundles: true,
    organizationId: row.organizationId ?? undefined,
    edges: workflow.edges,
  });
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  for (const issue of sendModes.issues) {
    const index =
      issue.nodeId === undefined ? undefined : indexById.get(issue.nodeId);
    result.errors.push({
      code: VALIDATION_ERROR_CODES.INVALID_SEND_MODE,
      message: issue.message,
      // MCP paths name the config without `data`; a node with no id keeps the save path.
      parameterPath:
        index === undefined || issue.field === undefined
          ? issue.path
          : `nodes[${index}].config.${issue.field}`,
    });
  }
  if (sendModes.issues.length > 0) {
    result.valid = false;
  }

  return NextResponse.json({
    ok: true,
    result: formatResult(result),
  });
}

/**
 * VALID-01 hard requirement: `errors` and `warnings` keys are ABSENT
 * from the response when the arrays are empty — NOT present as [].
 * The internal ValidationResult always carries both arrays; this function
 * strips them at the JSON boundary.
 */
function formatResult(result: ValidationResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    valid: result.valid,
    nodeCount: result.nodeCount,
  };
  if (result.errors.length > 0) {
    out.errors = result.errors;
  }
  if (result.warnings.length > 0) {
    out.warnings = result.warnings;
  }
  return out;
}
