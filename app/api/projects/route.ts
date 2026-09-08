import { and, count, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  resolveCreatorContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { COLOR_PALETTE } from "@/lib/palette";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { loadCreators } from "@/lib/security/creator-lookup";

export async function GET(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId } = authCtx;

    const orgProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        color: projects.color,
        organizationId: projects.organizationId,
        userId: projects.userId,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        workflowCount: count(workflows.id),
      })
      .from(projects)
      .leftJoin(
        workflows,
        and(
          eq(workflows.projectId, projects.id),
          ne(workflows.name, "__current__")
        )
      )
      .where(eq(projects.organizationId, organizationId))
      .groupBy(projects.id)
      .orderBy(projects.name);

    const creatorMap = await loadCreators(
      orgProjects.map((p) => p.userId),
      organizationId
    );

    const response = orgProjects.map((p) => {
      const creator = creatorMap.get(p.userId);
      return {
        ...p,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        createdByName: creator?.name ?? null,
        createdByEmail: creator?.email ?? null,
        createdByRole: creator?.role ?? null,
      };
    });

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Projects] Failed to list projects",
      error,
      { endpoint: "/api/projects", operation: "list" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list projects",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const resolved = await resolveCreatorContext(request);
    if ("error" in resolved) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }
    const scopeError = requireScope(resolved.scope, SCOPE_MCP_WRITE, {
      credentialType: resolved.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const { organizationId, userId: creatorUserId } = resolved;

    const body = await request.json().catch(() => ({}));
    const name = body.name?.trim();

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const existingCount = await db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.organizationId, organizationId));

    const colorIndex = (existingCount[0]?.value ?? 0) % COLOR_PALETTE.length;
    const color = body.color || COLOR_PALETTE[colorIndex];

    const [newProject] = await db
      .insert(projects)
      .values({
        name,
        description: body.description?.trim() || null,
        color,
        organizationId,
        userId: creatorUserId,
      })
      .returning();

    await recordAuditEvent({
      actor: {
        userId: creatorUserId,
        organizationId,
        authMethod: resolved.authMethod,
        apiKeyId: resolved.apiKeyId,
      },
      action: "project.created",
      resourceType: "project",
      resourceId: newProject.id,
      after: { name: newProject.name },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(
      {
        ...newProject,
        workflowCount: 0,
        createdAt: newProject.createdAt.toISOString(),
        updatedAt: newProject.updatedAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Projects] Failed to create project",
      error,
      { endpoint: "/api/projects", operation: "create" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create project",
      },
      { status: 500 }
    );
  }
}
