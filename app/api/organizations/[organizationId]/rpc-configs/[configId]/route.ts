import { NextResponse } from "next/server";
import {
  auditRpcChange,
  authorizeRpcRequest,
  failureResponse,
  invalidBodyResponse,
  RpcAccess,
  RpcAuditAction,
  readJson,
  serverErrorResponse,
  updateRpcConfigBody,
} from "@/lib/rpc/engine/org/http";
import {
  deleteOrgRpcConfig,
  updateOrgRpcConfig,
} from "@/lib/rpc/engine/org/service";

const ENDPOINT = "/api/organizations/[organizationId]/rpc-configs/[configId]";

type RouteContext = {
  params: Promise<{ organizationId: string; configId: string }>;
};

export async function PATCH(
  request: Request,
  context: RouteContext
): Promise<NextResponse> {
  try {
    const { organizationId, configId } = await context.params;
    const caller = await authorizeRpcRequest(
      request,
      organizationId,
      RpcAccess.WRITE
    );
    if (caller instanceof NextResponse) {
      return caller;
    }
    const parsed = updateRpcConfigBody.safeParse(await readJson(request));
    if (!parsed.success) {
      return invalidBodyResponse(parsed.error);
    }

    const result = await updateOrgRpcConfig({
      organizationId,
      configId,
      userId: caller.userId,
      ...parsed.data,
    });
    if (!result.ok) {
      return failureResponse(result);
    }

    await auditRpcChange({
      request,
      caller,
      organizationId,
      action: RpcAuditAction.CONFIG_UPDATED,
      resourceId: configId,
      after: {
        name: result.config.name,
        isDefault: result.config.isDefault,
        enabled: result.config.enabled,
        maskedUrls: result.config.maskedUrls,
      },
    });
    return NextResponse.json({ config: result.config });
  } catch (error) {
    return serverErrorResponse(error, ENDPOINT, "Failed to update RPC config");
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext
): Promise<NextResponse> {
  try {
    const { organizationId, configId } = await context.params;
    const caller = await authorizeRpcRequest(
      request,
      organizationId,
      RpcAccess.WRITE
    );
    if (caller instanceof NextResponse) {
      return caller;
    }

    const result = await deleteOrgRpcConfig({ organizationId, configId });
    if (!result.ok) {
      return failureResponse(result);
    }

    await auditRpcChange({
      request,
      caller,
      organizationId,
      action: RpcAuditAction.CONFIG_DELETED,
      resourceId: configId,
      after: { chainId: result.config.chainId, name: result.config.name },
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return serverErrorResponse(error, ENDPOINT, "Failed to delete RPC config");
  }
}
