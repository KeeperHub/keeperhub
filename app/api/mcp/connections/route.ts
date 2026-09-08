import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getOrgMaxScope,
  listConnections,
  listOrgMembers,
  type McpConnection,
} from "@/lib/mcp/connections";
import { resolveCaller } from "./_lib/guard";

type UserGroup = {
  userId: string;
  userName: string;
  userEmail: string;
  role: string;
  maxScope: string | null;
  /** An admin may not set an owner's access, so the UI must know. */
  canEdit: boolean;
  sessions: McpConnection[];
};

/** Most recently used first, then people who have never connected anything. */
function lastUsed(group: UserGroup): number {
  let latest = 0;
  for (const session of group.sessions) {
    const at = session.lastUsedAt ? session.lastUsedAt.getTime() : 0;
    latest = Math.max(latest, at);
  }
  return latest;
}

/**
 * GET /api/mcp/connections
 *
 * Everyone in the organization and the agents they have connected. The list is
 * built from the membership rather than from the sessions, so an admin can set
 * someone's limit before that person has connected anything: a member with no
 * agent still needs a row to be limited on.
 *
 * Admins and owners see everyone; a member sees only themselves, because the
 * filter is applied here rather than left to the client.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }

  try {
    const [connections, members] = await Promise.all([
      listConnections(
        caller.organizationId,
        caller.isAdmin ? undefined : caller.userId
      ),
      listOrgMembers(caller.organizationId),
    ]);

    const sessionsByUser = new Map<string, McpConnection[]>();
    for (const connection of connections) {
      const list = sessionsByUser.get(connection.userId) ?? [];
      list.push(connection);
      sessionsByUser.set(connection.userId, list);
    }

    const visible = caller.isAdmin
      ? members
      : members.filter((m) => m.userId === caller.userId);

    const users: UserGroup[] = visible.map((m) => ({
      canEdit:
        caller.isAdmin && (m.role !== "owner" || caller.role === "owner"),
      maxScope: m.maxScope,
      role: m.role,
      sessions: sessionsByUser.get(m.userId) ?? [],
      userEmail: m.userEmail,
      userId: m.userId,
      userName: m.userName,
    }));

    // Whoever has been active most recently leads; people with nothing
    // connected sort to the end by name, where they are still reachable to be
    // limited before they connect.
    users.sort(
      (a, b) =>
        lastUsed(b) - lastUsed(a) ||
        b.sessions.length - a.sessions.length ||
        (a.userName || a.userEmail).localeCompare(b.userName || b.userEmail)
    );

    return NextResponse.json({
      canManage: caller.isAdmin,
      maxScope: await getOrgMaxScope(caller.organizationId),
      users,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpConnections] Failed to list connections",
      error,
      { endpoint: "/api/mcp/connections", operation: "list" }
    );
    return NextResponse.json(
      { error: "Could not load connections" },
      { status: 500 }
    );
  }
}
