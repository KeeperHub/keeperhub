import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  apiKeys,
  integrations,
  member,
  organizationApiKeys,
  securityAuditLog,
  users,
  workflowHistory,
  workflows,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { redactAuditDiff } from "@/lib/security/audit-redaction";

// Max characters honored from the free-text search; longer input is truncated
// so a pathological query can't blow up the LIKE scan.
const MAX_SEARCH_LENGTH = 200;
// LIKE wildcards + the escape char, neutralized so the user's text is matched
// literally rather than acting as a pattern.
const LIKE_SPECIAL = /[\\%_]/g;

/**
 * Read the org's security audit trail. Sensitive forensic data, so it is
 * session-gated and limited to organization owners/admins; the events are
 * always scoped to the caller's active organization. Filterable by action,
 * resource, and actor, with a created_at cursor for pagination -- all of
 * which are served by the composite indexes on security_audit_log.
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgCtx = await resolveOrganizationId(request);
    if ("error" in orgCtx) {
      return NextResponse.json(
        { error: orgCtx.error },
        { status: orgCtx.status }
      );
    }
    const { organizationId } = orgCtx;

    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.userId, session.user.id),
          eq(member.organizationId, organizationId)
        )
      )
      .limit(1);

    if (
      !membership ||
      (membership.role !== "owner" && membership.role !== "admin")
    ) {
      return NextResponse.json(
        { error: "Only organization owners and admins can view the audit log" },
        { status: 403 }
      );
    }

    const url = new URL(request.url);
    const req = parsePageRequest(url);
    const action = url.searchParams.get("action");
    const resourceTypes = url.searchParams.getAll("resourceType");
    const resourceIds = url.searchParams.getAll("resourceId");
    const projectIds = url.searchParams.getAll("projectId");
    const tagIds = url.searchParams.getAll("tagId");
    const workflowIds = url.searchParams.getAll("workflowId");
    const actorUserIds = url.searchParams.getAll("actorUserId");
    const correlationId = url.searchParams.get("correlationId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const conditions = [eq(securityAuditLog.organizationId, organizationId)];
    if (action) {
      conditions.push(eq(securityAuditLog.action, action));
    }
    if (resourceTypes.length === 1) {
      conditions.push(eq(securityAuditLog.resourceType, resourceTypes[0]));
    } else if (resourceTypes.length > 1) {
      conditions.push(inArray(securityAuditLog.resourceType, resourceTypes));
    }

    // Resolve the relational resource filter entirely in the database. A
    // project or tag selection means "every event for that container AND for
    // the workflows currently under it"; the membership lookup is a single
    // org-scoped query, so the client never assembles the id set. Explicit
    // resourceId/workflowId selections are unioned in. When any resource
    // dimension is requested but resolves to no ids, the empty inArray yields
    // no rows -- the intended "nothing matches" result.
    const usesResourceFilter =
      resourceIds.length > 0 ||
      projectIds.length > 0 ||
      tagIds.length > 0 ||
      workflowIds.length > 0;
    if (usesResourceFilter) {
      const resourceIdSet = new Set<string>([
        ...resourceIds,
        ...workflowIds,
        ...projectIds,
        ...tagIds,
      ]);
      if (projectIds.length > 0 || tagIds.length > 0) {
        const membershipFilters = [
          ...(projectIds.length > 0
            ? [inArray(workflows.projectId, projectIds)]
            : []),
          ...(tagIds.length > 0 ? [inArray(workflows.tagId, tagIds)] : []),
        ];
        const owned = await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.organizationId, organizationId),
              or(...membershipFilters)
            )
          );
        for (const w of owned) {
          resourceIdSet.add(w.id);
        }
      }
      const ids = [...resourceIdSet];
      conditions.push(
        ids.length === 1
          ? eq(securityAuditLog.resourceId, ids[0])
          : inArray(securityAuditLog.resourceId, ids)
      );
    }
    if (actorUserIds.length === 1) {
      conditions.push(eq(securityAuditLog.actorUserId, actorUserIds[0]));
    } else if (actorUserIds.length > 1) {
      conditions.push(inArray(securityAuditLog.actorUserId, actorUserIds));
    }
    // Read one cascade back as a unit. ANDed with the org scope above, so a
    // correlation id can only ever surface the caller's own org's events.
    if (correlationId) {
      conditions.push(eq(securityAuditLog.correlationId, correlationId));
    }
    const fromDate = from ? new Date(from) : null;
    if (fromDate && !Number.isNaN(fromDate.getTime())) {
      conditions.push(gte(securityAuditLog.createdAt, fromDate));
    }
    const toDate = to ? new Date(to) : null;
    if (toDate && !Number.isNaN(toDate.getTime())) {
      conditions.push(lte(securityAuditLog.createdAt, toDate));
    }

    // Free-text search across the human-meaningful fields: the denormalized
    // actor label, the action, the resource id, the actor's current name/email,
    // matching resource NAMES (workflows, integrations by name or type, org and
    // personal API keys), and the request IP. Resource rows carry only ids, so
    // names are resolved to id sets first and matched back via resourceId. Every
    // comparison is a parameterized ILIKE (Drizzle binds the value, so no SQL
    // injection) with the user's wildcards escaped so the text matches
    // literally. The IP lives in the metadata JSONB and is matched through
    // Postgres' `->>` accessor, so the filter runs in the database rather than
    // by scanning rows in JS.
    const q = (url.searchParams.get("q") ?? "")
      .trim()
      .slice(0, MAX_SEARCH_LENGTH);
    if (q) {
      const pattern = `%${q.replace(LIKE_SPECIAL, (c) => `\\${c}`)}%`;
      const [
        matchedActors,
        matchedWorkflows,
        matchedIntegrations,
        matchedOrgKeys,
        matchedPersonalKeys,
      ] = await Promise.all([
        db
          .select({ id: users.id })
          .from(users)
          .innerJoin(
            member,
            and(
              eq(member.userId, users.id),
              eq(member.organizationId, organizationId)
            )
          )
          .where(or(ilike(users.name, pattern), ilike(users.email, pattern))),
        db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.organizationId, organizationId),
              ilike(workflows.name, pattern)
            )
          ),
        // Integrations match on the display name OR the provider type, so
        // "discord" finds Discord connections even when left unnamed.
        db
          .select({ id: integrations.id })
          .from(integrations)
          .where(
            and(
              eq(integrations.organizationId, organizationId),
              or(
                ilike(integrations.name, pattern),
                ilike(integrations.type, pattern)
              )
            )
          ),
        db
          .select({ id: organizationApiKeys.id })
          .from(organizationApiKeys)
          .where(
            and(
              eq(organizationApiKeys.organizationId, organizationId),
              ilike(organizationApiKeys.name, pattern)
            )
          ),
        // Personal/webhook keys are user-scoped; the org-scoped audit query
        // already bounds which of these ids can surface, so no org filter here.
        db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(ilike(apiKeys.name, pattern)),
      ]);
      const resourceIdMatches = [
        ...matchedWorkflows.map((w) => w.id),
        ...matchedIntegrations.map((i) => i.id),
        ...matchedOrgKeys.map((k) => k.id),
        ...matchedPersonalKeys.map((k) => k.id),
      ];
      const searchConditions = [
        ilike(securityAuditLog.actorLabel, pattern),
        ilike(securityAuditLog.action, pattern),
        ilike(securityAuditLog.resourceId, pattern),
        sql`(${securityAuditLog.metadata} ->> 'ip') ILIKE ${pattern}`,
      ];
      if (matchedActors.length > 0) {
        searchConditions.push(
          inArray(
            securityAuditLog.actorUserId,
            matchedActors.map((a) => a.id)
          )
        );
      }
      if (resourceIdMatches.length > 0) {
        searchConditions.push(
          inArray(securityAuditLog.resourceId, resourceIdMatches)
        );
      }
      const searchClause = or(...searchConditions);
      if (searchClause) {
        conditions.push(searchClause);
      }
    }

    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(securityAuditLog)
      .where(where);

    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(where)
      .orderBy(desc(securityAuditLog.createdAt))
      .limit(req.pageSize)
      .offset(req.offset);

    // Enrich actor ids -> name/email/role so the UI can identify "who did it"
    // unambiguously (the org role disambiguates same-named users). Role is the
    // actor's membership role in the caller's org (null if they are no longer a
    // member).
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

    // Name the affected workflow so the feed can show "which workflow" and
    // link into it. Org-scoped; soft-deleted workflows are kept so their
    // name still resolves. Other resource types have no in-app history view
    // to link to, so they are left unnamed here.
    const workflowResourceIds = [
      ...new Set(
        rows
          .filter((r) => r.resourceType === "workflow" && r.resourceId)
          .map((r) => r.resourceId)
      ),
    ] as string[];
    const workflowNames = workflowResourceIds.length
      ? await db
          .select({ id: workflows.id, name: workflows.name })
          .from(workflows)
          .where(
            and(
              eq(workflows.organizationId, organizationId),
              inArray(workflows.id, workflowResourceIds)
            )
          )
      : [];
    const workflowNameMap = new Map(workflowNames.map((w) => [w.id, w.name]));

    // Names for the other audited resources so a row shows which one and can
    // open its activity. Resolved by id; org-owned tables are also org-scoped.
    const idsForType = (type: string): string[] =>
      [
        ...new Set(
          rows
            .filter((r) => r.resourceType === type && r.resourceId)
            .map((r) => r.resourceId)
        ),
      ].filter((id): id is string => id !== null);
    const integrationIds = idsForType("integration");
    const orgKeyIds = idsForType("org_api_key");
    const personalKeyIds = idsForType("api_key");
    // An agent-access change is about a person, so the row has to name them.
    // A revoked session carries "<clientId>::<userId>", so the person is the
    // tail of it.
    const subjectUserIds = [
      ...idsForType("mcp_member_scope"),
      ...idsForType("mcp_connection").map((id) =>
        id.slice(id.indexOf("::") + 2)
      ),
    ].filter((id) => id.length > 0);
    const integrationRows = integrationIds.length
      ? await db
          .select({
            id: integrations.id,
            name: integrations.name,
            type: integrations.type,
          })
          .from(integrations)
          .where(
            and(
              eq(integrations.organizationId, organizationId),
              inArray(integrations.id, integrationIds)
            )
          )
      : [];
    const orgKeyRows = orgKeyIds.length
      ? await db
          .select({
            id: organizationApiKeys.id,
            name: organizationApiKeys.name,
          })
          .from(organizationApiKeys)
          .where(
            and(
              eq(organizationApiKeys.organizationId, organizationId),
              inArray(organizationApiKeys.id, orgKeyIds)
            )
          )
      : [];
    const subjectUserRows = subjectUserIds.length
      ? await db
          .select({
            email: users.email,
            id: users.id,
            image: users.image,
            name: users.name,
          })
          .from(users)
          .where(inArray(users.id, subjectUserIds))
      : [];
    const personalKeyRows = personalKeyIds.length
      ? await db
          .select({ id: apiKeys.id, name: apiKeys.name })
          .from(apiKeys)
          .where(inArray(apiKeys.id, personalKeyIds))
      : [];
    // Carry the type so the feed says which kind of integration. Show the type
    // alone when it is the only label (no distinct name), else "Name · Type".
    const integrationLabel = (name: string, type: string): string => {
      const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
      const trimmed = name.trim();
      return trimmed && trimmed.toLowerCase() !== type.toLowerCase()
        ? `${trimmed} · ${typeLabel}`
        : typeLabel;
    };
    const integrationNameMap = new Map(
      integrationRows.map((i) => [i.id, integrationLabel(i.name, i.type)])
    );
    const orgKeyNameMap = new Map(orgKeyRows.map((k) => [k.id, k.name]));
    const personalKeyNameMap = new Map(
      personalKeyRows.map((k) => [k.id, k.name])
    );
    // The affected party is a person, so the feed is given the identity to
    // render rather than a name it would have to make a chip out of.
    const subjectUserMap = new Map(subjectUserRows.map((u) => [u.id, u]));

    const subjectUserFor = (
      type: string | null,
      id: string | null
    ): {
      id: string;
      name: string | null;
      email: string | null;
      image: string | null;
    } | null => {
      if (!(type && id)) {
        return null;
      }
      if (type === "mcp_member_scope") {
        return subjectUserMap.get(id) ?? null;
      }
      if (type === "mcp_connection") {
        return subjectUserMap.get(id.slice(id.indexOf("::") + 2)) ?? null;
      }
      return null;
    };
    const resourceNameFor = (
      type: string | null,
      id: string | null
    ): string | null => {
      if (!(type && id)) {
        return null;
      }
      if (type === "workflow") {
        return workflowNameMap.get(id) ?? null;
      }
      if (type === "integration") {
        return integrationNameMap.get(id) ?? null;
      }
      if (type === "org_api_key") {
        return orgKeyNameMap.get(id) ?? null;
      }
      if (type === "api_key") {
        return personalKeyNameMap.get(id) ?? null;
      }
      return null;
    };

    // Link each workflow event to the history version written in the same
    // request, matched by near-identical timestamp (the audit row and the
    // snapshot are persisted together). This resolves the exact version each
    // event produced -- across definition, rename, and enable changes -- so the
    // feed can deep-link straight to it. A tight tolerance rejects events that
    // produced no snapshot (e.g. a no-op autosave).
    const VERSION_MATCH_TOLERANCE_MS = 3000;
    const versionByEventId = new Map<string, number>();
    const workflowRows = rows.filter(
      (r) => r.resourceType === "workflow" && r.resourceId
    );
    if (workflowRows.length > 0) {
      const eventTimes = workflowRows.map((r) => r.createdAt.getTime());
      const windowStart = new Date(
        Math.min(...eventTimes) - VERSION_MATCH_TOLERANCE_MS
      );
      const windowEnd = new Date(
        Math.max(...eventTimes) + VERSION_MATCH_TOLERANCE_MS
      );
      const historyRows = await db
        .select({
          workflowId: workflowHistory.workflowId,
          version: workflowHistory.version,
          createdAt: workflowHistory.createdAt,
        })
        .from(workflowHistory)
        .where(
          and(
            inArray(workflowHistory.workflowId, workflowResourceIds),
            gte(workflowHistory.createdAt, windowStart),
            lte(workflowHistory.createdAt, windowEnd)
          )
        );
      const historyByWorkflow = new Map<
        string,
        { version: number; time: number }[]
      >();
      for (const h of historyRows) {
        const list = historyByWorkflow.get(h.workflowId) ?? [];
        list.push({ version: h.version, time: h.createdAt.getTime() });
        historyByWorkflow.set(h.workflowId, list);
      }
      for (const r of workflowRows) {
        const candidates = r.resourceId
          ? historyByWorkflow.get(r.resourceId)
          : undefined;
        if (!candidates) {
          continue;
        }
        const eventTime = r.createdAt.getTime();
        let best: { version: number; time: number } | null = null;
        for (const c of candidates) {
          const delta = Math.abs(c.time - eventTime);
          if (
            delta <= VERSION_MATCH_TOLERANCE_MS &&
            (best === null || delta < Math.abs(best.time - eventTime))
          ) {
            best = c;
          }
        }
        if (best) {
          versionByEventId.set(r.id, best.version);
        }
      }
    }
    // Return an explicit, display-only DTO -- never the raw row. Spreading the
    // row would leak internal audit columns (apiKeyId, authMethod,
    // correlationId, outcome, org/actor labels) and the unredacted diff to the
    // client. Only the fields the activity view consumes are exposed, and the
    // diff is redacted server-side so secrets never reach the wire.
    const items = rows.map((r) => {
      const enriched = r.actorUserId ? actorMap.get(r.actorUserId) : undefined;
      // Fall back to the denormalized actor_label when the user row is gone (a
      // deletion cascade nulls actor_user_id) so the trail still attributes the
      // action instead of rendering as "System".
      let actor: {
        id: string | null;
        name?: string | null;
        email?: string | null;
        role?: string | null;
      } | null = null;
      if (enriched) {
        actor = enriched;
      } else if (r.actorLabel) {
        actor = { id: r.actorUserId, name: r.actorLabel };
      } else if (r.actorUserId) {
        actor = { id: r.actorUserId };
      }
      // Expose only ip + country. userAgent is stored for forensics but the
      // UI never renders it, so it stays server-side.
      const meta = r.metadata as Record<string, unknown> | null;
      return {
        id: r.id,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        resourceName: resourceNameFor(r.resourceType, r.resourceId),
        resourceUser: subjectUserFor(r.resourceType, r.resourceId),
        version:
          versionByEventId.get(r.id) ??
          (r.resourceType === "workflow" && r.action.endsWith(".created")
            ? 1
            : null),
        createdAt: r.createdAt,
        diff: redactAuditDiff(r.diff),
        metadata: meta
          ? { ip: meta.ip ?? null, country: meta.country ?? null }
          : null,
        actor,
      };
    });

    return NextResponse.json(buildPage(items, total, req, url));
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to read security audit log",
      error,
      { endpoint: "/api/security/audit" }
    );
    return NextResponse.json(
      { error: "Failed to read security audit log" },
      { status: 500 }
    );
  }
}
