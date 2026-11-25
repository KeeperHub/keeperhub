import { NextResponse } from "next/server";
import {
  authorizeRpcRequest,
  failureResponse,
  RpcAccess,
  serverErrorResponse,
} from "@/lib/rpc/engine/org/http";
import { retestOrgRpcConfig } from "@/lib/rpc/engine/org/service";

const ENDPOINT =
  "/api/organizations/[organizationId]/rpc-configs/[configId]/test";

type RouteContext = {
  params: Promise<{ organizationId: string; configId: string }>;
};

export async function POST(
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
    const result = await retestOrgRpcConfig({ organizationId, configId });
    if (!result.ok) {
      return failureResponse(result);
    }
    return NextResponse.json({ config: result.config, allOk: result.allOk });
  } catch (error) {
    return serverErrorResponse(error, ENDPOINT, "Failed to test RPC config");
  }
}
