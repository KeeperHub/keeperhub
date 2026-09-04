import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { toChecksumAddress } from "@/lib/address-utils";
import { db } from "@/lib/db";
import {
  deleteIntegration,
  getIntegration,
  updateIntegration,
} from "@/lib/db/integrations";
import { organizationWallets } from "@/lib/db/schema";
import { stripSecretConfig } from "@/lib/integrations/secret-fields";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_READ, SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import type { IntegrationConfig } from "@/lib/types/integration";

export type GetIntegrationResponse = {
  id: string;
  name: string;
  type: string;
  config: IntegrationConfig;
  createdAt: string;
  updatedAt: string;
  walletAddress?: string;
};

export type UpdateIntegrationRequest = {
  name?: string;
  config?: IntegrationConfig;
};

/**
 * GET /api/integrations/[integrationId]
 * Get a single integration. Credential values are never included.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ integrationId: string }> }
) {
  try {
    const { integrationId } = await context.params;
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId } = authContext;

    if (!(userId || organizationId)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_READ, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const integration = await getIntegration(
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

    const response: GetIntegrationResponse = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      config: stripSecretConfig(integration.config, integration.type),
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };

    if (integration.type === "web3" && organizationId) {
      const walletRow = await db
        .select({ walletAddress: organizationWallets.walletAddress })
        .from(organizationWallets)
        .where(
          and(
            eq(organizationWallets.organizationId, organizationId),
            eq(organizationWallets.isActive, true)
          )
        )
        .limit(1);

      if (walletRow.length > 0) {
        response.walletAddress = toChecksumAddress(walletRow[0].walletAddress);
      }
    }

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get integration", error, {
      endpoint: "/api/integrations/[integrationId]",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get integration",
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/integrations/[integrationId]
 * Update an integration
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ integrationId: string }> }
) {
  try {
    const { integrationId } = await context.params;
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId } = authContext;

    if (!(userId || organizationId)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const body: UpdateIntegrationRequest = await request.json();

    // Fetch existing integration so updateIntegration can merge database
    // secrets without an extra DB round-trip.
    const existing =
      body.config === undefined
        ? null
        : await getIntegration(integrationId, userId ?? "", organizationId);

    if (body.config !== undefined && !existing) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    const integration = await updateIntegration(
      integrationId,
      userId ?? "",
      body,
      organizationId,
      existing
    );

    if (!integration) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    // Only the name and a "config changed" flag -- never the config values.
    await recordAuditEvent({
      actor: {
        userId: userId ?? null,
        organizationId,
        authMethod: authContext.authMethod,
        apiKeyId: authContext.apiKeyId,
      },
      action: "integration.updated",
      resourceType: "integration",
      resourceId: integration.id,
      before: existing ? { name: existing.name } : undefined,
      after: {
        name: integration.name,
        configUpdated: body.config !== undefined,
      },
      metadata: buildAuditMetadata(request),
    });

    const response: GetIntegrationResponse = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      config: stripSecretConfig(integration.config, integration.type),
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to update integration",
      error,
      {
        endpoint: "/api/integrations/[integrationId]",
        operation: "update",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update integration",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/integrations/[integrationId]
 * Delete an integration
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ integrationId: string }> }
) {
  try {
    const { integrationId } = await context.params;
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId } = authContext;

    if (!(userId || organizationId)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    // Capture name/type before deletion so the audit trail can name what went.
    const existing = await getIntegration(
      integrationId,
      userId ?? "",
      organizationId
    );

    const success = await deleteIntegration(
      integrationId,
      userId ?? "",
      organizationId
    );

    if (!success) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    await recordAuditEvent({
      actor: {
        userId: userId ?? null,
        organizationId,
        authMethod: authContext.authMethod,
        apiKeyId: authContext.apiKeyId,
      },
      action: "integration.deleted",
      resourceType: "integration",
      resourceId: integrationId,
      before: existing
        ? { name: existing.name, type: existing.type }
        : undefined,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to delete integration",
      error,
      {
        endpoint: "/api/integrations/[integrationId]",
        operation: "delete",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete integration",
      },
      { status: 500 }
    );
  }
}
