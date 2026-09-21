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
import {
  storedSecretKeys,
  stripSecretConfig,
} from "@/lib/integrations/secret-fields";
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
  /**
   * Which secret keys hold a value, never the values. The form needs this to
   * say which of two alternative credentials is in use and to warn when both
   * are, neither of which it can work out from `config` - secrets are
   * stripped from it.
   */
  storedSecretKeys: string[];
  createdAt: string;
  updatedAt: string;
  walletAddress?: string;
};

export type UpdateIntegrationRequest = {
  name?: string;
  config?: IntegrationConfig;
  /** Config keys to remove. See `updateIntegration` for why this is needed. */
  clearedConfigKeys?: string[];
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
      storedSecretKeys: storedSecretKeys(integration.config, integration.type),
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

    // Whatever arrived, this reaches the database as a list of strings.
    const clearedConfigKeys = Array.isArray(body.clearedConfigKeys)
      ? body.clearedConfigKeys.filter(
          (key): key is string => typeof key === "string" && key.length > 0
        )
      : [];

    // Fetch existing integration so updateIntegration can merge database
    // secrets without an extra DB round-trip.
    const touchesConfig =
      body.config !== undefined || clearedConfigKeys.length > 0;
    const existing = touchesConfig
      ? await getIntegration(integrationId, userId ?? "", organizationId)
      : null;

    if (touchesConfig && !existing) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    // What actually went, compared against what is stored: a key sent with a
    // new value in the same request is a rotation and keeps that value, and a
    // key the connection never held was never there to remove.
    const removedConfigKeys = clearedConfigKeys.filter((key) => {
      const replacement = body.config?.[key];
      const supplied =
        replacement !== undefined && replacement !== null && replacement !== "";
      return !supplied && existing !== null && key in existing.config;
    });

    const integration = await updateIntegration(
      integrationId,
      userId ?? "",
      { ...body, clearedConfigKeys },
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
        configUpdated: touchesConfig,
        // Named, because removing a credential is the one update here that
        // destroys something. Key names only - never a value - so the log can
        // tell a rotation from a deletion, and say which credential went.
        ...(removedConfigKeys.length > 0
          ? { clearedConfigKeys: removedConfigKeys }
          : {}),
      },
      metadata: buildAuditMetadata(request),
    });

    const response: GetIntegrationResponse = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      config: stripSecretConfig(integration.config, integration.type),
      storedSecretKeys: storedSecretKeys(integration.config, integration.type),
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
