import { NextResponse } from "next/server";
import {
  auditRpcChange,
  authorizeRpcRequest,
  failureResponse,
  invalidBodyResponse,
  RpcAccess,
  RpcAuditAction,
  readJson,
  rpcPolicyBody,
  serverErrorResponse,
} from "@/lib/rpc/engine/org/http";
import {
  getOrgRpcPolicyView,
  setOrgRpcPolicy,
} from "@/lib/rpc/engine/org/service";

const ENDPOINT = "/api/organizations/[organizationId]/rpc-policy";

type RouteContext = { params: Promise<{ organizationId: string }> };

export async function GET(
  request: Request,
  context: RouteContext
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const caller = await authorizeRpcRequest(
      request,
      organizationId,
      RpcAccess.READ
    );
    if (caller instanceof NextResponse) {
      return caller;
    }
    return NextResponse.json(await getOrgRpcPolicyView(organizationId));
  } catch (error) {
    return serverErrorResponse(error, ENDPOINT, "Failed to load RPC policy");
  }
}

export async function PUT(
  request: Request,
  context: RouteContext
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const caller = await authorizeRpcRequest(
      request,
      organizationId,
      RpcAccess.WRITE
    );
    if (caller instanceof NextResponse) {
      return caller;
    }
    const parsed = rpcPolicyBody.safeParse(await readJson(request));
    if (!parsed.success) {
      return invalidBodyResponse(parsed.error);
    }

    const result = await setOrgRpcPolicy({
      organizationId,
      userId: caller.userId,
      ownRpcOnly: parsed.data.ownRpcOnly,
    });
    if (!result.ok) {
      return failureResponse(result);
    }

    await auditRpcChange({
      request,
      caller,
      organizationId,
      action: RpcAuditAction.POLICY_CHANGED,
      resourceId: organizationId,
      after: { ownRpcOnly: result.policy.ownRpcOnly },
    });
    return NextResponse.json(result.policy);
  } catch (error) {
    return serverErrorResponse(error, ENDPOINT, "Failed to save RPC policy");
  }
}
