import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { toChecksumAddress } from "@/lib/address-utils";
import { db } from "@/lib/db";
import {
  deleteIntegration,
  getIntegration,
  stripDatabaseSecrets,
  updateIntegration,
} from "@/lib/db/integrations";
import { organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
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
 * Get a single integration with decrypted config
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
      config: stripDatabaseSecrets(integration.config, integration.type),
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };

    if (integration.type === "web3" && organizationId) {
      const walletRow = await db
        .select({ walletAddress: organizationWallets.walletAddress })
        .from(organizationWallets)
        .where(eq(organizationWallets.organizationId, organizationId))
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

    const response: GetIntegrationResponse = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      config: stripDatabaseSecrets(integration.config, integration.type),
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
