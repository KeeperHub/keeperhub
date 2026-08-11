import { NextResponse } from "next/server";
import {
  getIntegration as getIntegrationFromDb,
  mergeDatabaseConfig,
} from "@/lib/db/integrations";
import { handleDatabaseTest, handlePluginTest } from "@/lib/db/test-connection";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import type { IntegrationConfig } from "@/lib/types/integration";

export type { TestConnectionResult } from "@/lib/db/test-connection";

type TestRequestBody = { configOverrides?: IntegrationConfig };

async function parseJsonBody(
  request: Request
): Promise<TestRequestBody | NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }
  try {
    return await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> }
): Promise<NextResponse> {
  try {
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

    const { integrationId } = await params;

    if (!integrationId) {
      return NextResponse.json(
        { error: "integrationId is required" },
        { status: 400 }
      );
    }

    // getIntegrationFromDb prefers the org filter when organizationId is set,
    // ignoring userId; otherwise it falls back to a userId match. For API-key
    // callers the org path is the only one that fires, so userId ?? "" is a
    // safe placeholder. The pattern matches PATCH /api/integrations/[id].
    const integration = await getIntegrationFromDb(
      integrationId,
      userId ?? "",
      organizationId
    );

    if (!integration) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    // Parse optional config overrides from the request body.
    // For database integrations, overrides are merged with stored config so the
    // server can test with updated non-secret fields (e.g. host) without
    // the client needing to send the password.
    const bodyOrError = await parseJsonBody(request);
    if (bodyOrError instanceof NextResponse) {
      return bodyOrError;
    }
    const body = bodyOrError;

    if (integration.type === "database") {
      const testConfig = body.configOverrides
        ? mergeDatabaseConfig(integration.config, body.configOverrides)
        : integration.config;
      const result = await handleDatabaseTest(testConfig);
      return NextResponse.json(result);
    }

    const result = await handlePluginTest(integration.type, integration.config);
    if (
      result.message === "Invalid integration type" ||
      result.message === "Integration does not support testing"
    ) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to test connection";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
