import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { redactAuditDiff } from "@/lib/security/audit-redaction";
import { toCsvCell } from "@/lib/security/csv";

/**
 * Compliance export of the org's security audit trail as CSV.
 *
 * Sensitive: pulling the full forensic history is owner-only and gated behind
 * dual-factor (authenticator TOTP + emailed OTP), the same guard the wallet
 * withdraw uses. POST so the MFA codes ride in the body, never the URL. On a
 * missing/invalid factor it returns the dual-factor challenge JSON; on success
 * it streams the CSV. The diff column is redacted server-side; internal columns
 * (apiKeyId, correlationId, outcome, ...) are not exported.
 *
 * Optional `days` (7/30/90) and `resourceTypes[]` narrow the export to match
 * the activity view; they bound file size only and are NOT plan-gated.
 */

const MAX_EXPORT_ROWS = 50_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ALLOWED_RANGE_DAYS = new Set([7, 30, 90]);

const COLUMNS = [
  "created_at",
  "action",
  "actor_name",
  "actor_email",
  "actor_role",
  "ip",
  "country",
  "resource_type",
  "resource_id",
  "diff",
] as const;

type ExportBody = {
  days?: number | string;
  resourceTypes?: unknown;
  code?: string;
  emailOtp?: string;
  signature?: string;
};

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const organizationId = getActiveOrgId(session);
    if (!organizationId) {
      return Response.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as ExportBody;

    const authorized = await authorizeAction({
      session,
      action: STEP_UP_ACTIONS.auditExport,
      roleFloor: "owner",
      organizationId,
      body,
      headers: request.headers,
    });
    if (!authorized.ok) {
      return authorized.response;
    }

    const rawDays = Number.parseInt(String(body.days ?? ""), 10);
    const windowDays = ALLOWED_RANGE_DAYS.has(rawDays) ? rawDays : null;
    const resourceTypes = Array.isArray(body.resourceTypes)
      ? body.resourceTypes.filter((t): t is string => typeof t === "string")
      : [];

    const filters = [eq(securityAuditLog.organizationId, organizationId)];
    if (windowDays) {
      filters.push(
        gte(
          securityAuditLog.createdAt,
          new Date(Date.now() - windowDays * MS_PER_DAY)
        )
      );
    }
    if (resourceTypes.length === 1) {
      filters.push(eq(securityAuditLog.resourceType, resourceTypes[0]));
    } else if (resourceTypes.length > 1) {
      filters.push(inArray(securityAuditLog.resourceType, resourceTypes));
    }

    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(and(...filters))
      .orderBy(desc(securityAuditLog.createdAt))
      .limit(MAX_EXPORT_ROWS);

    const actorIds = [
      ...new Set(rows.map((r) => r.actorUserId).filter(Boolean)),
    ] as string[];
    const actors = actorIds.length
      ? await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: member.role,
          })
          .from(users)
          .leftJoin(
            member,
            and(
              eq(member.userId, users.id),
              eq(member.organizationId, organizationId)
            )
          )
          .where(inArray(users.id, actorIds))
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    const lines: string[] = [COLUMNS.join(",")];
    for (const r of rows) {
      const actor = r.actorUserId ? actorMap.get(r.actorUserId) : undefined;
      lines.push(
        [
          toCsvCell(r.createdAt.toISOString()),
          toCsvCell(r.action),
          toCsvCell(actor?.name ?? r.actorLabel ?? null),
          toCsvCell(actor?.email ?? null),
          toCsvCell(actor?.role ?? null),
          toCsvCell((r.metadata as { ip?: unknown } | null)?.ip ?? null),
          toCsvCell(
            (r.metadata as { country?: unknown } | null)?.country ?? null
          ),
          toCsvCell(r.resourceType),
          toCsvCell(r.resourceId),
          toCsvCell(redactAuditDiff(r.diff)),
        ].join(",")
      );
    }

    const filename = windowDays
      ? `audit-log-last-${windowDays}d.csv`
      : "audit-log.csv";
    return new Response(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to export security audit log",
      error,
      { endpoint: "/api/security/audit/export" }
    );
    return Response.json(
      { error: "Failed to export security audit log" },
      { status: 500 }
    );
  }
}
