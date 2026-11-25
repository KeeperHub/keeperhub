import { NextResponse } from "next/server";
import {
  auditRpcChange,
  authorizeRpcRequest,
  createRpcConfigBody,
  failureResponse,
  invalidBodyResponse,
  RpcAccess,
  RpcAuditAction,
  readJson,
  serverErrorResponse,
} from "@/lib/rpc/engine/org/http";
import {
  createOrgRpcConfig,
  listOrgRpcConfigs,
} from "@/lib/rpc/engine/org/service";

const ENDPOINT = "/api/organizations/[organizationId]/rpc-configs";

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
    return NextResponse.json({
      configs: await listOrgRpcConfigs(organizationId),
    });
  } catch (error) {
    return serverErrorResponse(error, ENDPOINT, "Failed to load RPC configs");
  }
}

export async function POST(
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
    const parsed = createRpcConfigBody.safeParse(await readJson(request));
    if (!parsed.success) {
      return invalidBodyResponse(parsed.error);
    }

    const result = await createOrgRpcConfig({
      organizationId,
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
      action: RpcAuditAction.CONFIG_CREATED,
      resourceId: result.config.id,
      after: {
        chainId: result.config.chainId,
        name: result.config.name,
        isDefault: result.config.isDefault,
        enabled: result.config.enabled,
        maskedUrls: result.config.maskedUrls,
      },
    });
    return NextResponse.json({ config: result.config }, { status: 201 });
  } catch (error) {
    return serverErrorResponse(error, ENDPOINT, "Failed to save RPC config");
  }
}
