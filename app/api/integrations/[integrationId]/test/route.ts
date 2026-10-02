import { NextResponse } from "next/server";
import { getIntegration as getIntegrationFromDb } from "@/lib/db/integrations";
import { handleDatabaseTest, handlePluginTest } from "@/lib/db/test-connection";
import {
  mergeSecretConfig,
  removeClearedKeys,
} from "@/lib/integrations/secret-fields";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import type { IntegrationConfig } from "@/lib/types/integration";

export type { TestConnectionResult } from "@/lib/db/test-connection";

type TestRequestBody = {
  configOverrides?: IntegrationConfig;
  /**
   * Keys the caller is about to remove. The merge below fills every key the
   * caller did not send from what is stored, so without this the test
   * authenticated with the very credential the save was about to delete and
   * reported a healthy connection.
   */
  clearedConfigKeys?: string[];
};

async function parseJsonBody(
  request: Request
): Promise<TestRequestBody | NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }
  // Testing an unchanged connection sends nothing to override, and the shared
  // client stamps the JSON content type on every request regardless, so an
  // empty body is a valid "test what is stored" rather than malformed input.
  const raw = (await request.text()).trim();
  if (raw.length === 0) {
    return {};
  }
  const invalid = NextResponse.json(
    { error: "Invalid JSON in request body" },
    { status: 400 }
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid;
  }
  return parsed as TestRequestBody;
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

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
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

    // Parse optional config overrides from the request body. Overrides are
    // merged with the stored config so the server can test with updated
    // non-secret fields without the client holding the credential.
    const bodyOrError = await parseJsonBody(request);
    if (bodyOrError instanceof NextResponse) {
      return bodyOrError;
    }
    const body = bodyOrError;

    const clearedConfigKeys = Array.isArray(body.clearedConfigKeys)
      ? body.clearedConfigKeys.filter(
          (key): key is string => typeof key === "string" && key.length > 0
        )
      : [];
    const merged = body.configOverrides
      ? mergeSecretConfig(
          integration.config,
          body.configOverrides,
          integration.type
        )
      : integration.config;
    const testConfig = removeClearedKeys(
      merged,
      clearedConfigKeys,
      body.configOverrides ?? {}
    );

    if (integration.type === "database") {
      const result = await handleDatabaseTest(testConfig);
      return NextResponse.json(result);
    }

    const result = await handlePluginTest(integration.type, testConfig);
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
