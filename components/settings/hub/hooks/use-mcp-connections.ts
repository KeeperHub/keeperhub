"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useSettingsContext } from "../settings-context";
import { useCachedSection } from "./use-cached-section";

export type McpConnectionRow = {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  userName: string;
  userEmail: string;
  scope: string;
  connectedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type McpUserGroup = {
  userId: string;
  userName: string;
  userEmail: string;
  role: string;
  /** This person's ceiling, which is what the access control sets. */
  maxScope: string | null;
  /** False when the caller may see this person's access but not set it. */
  canEdit: boolean;
  sessions: McpConnectionRow[];
};

type ConnectionsResponse = {
  users: McpUserGroup[];
  canManage: boolean;
  maxScope: string | null;
};

export type McpConnectionsState = {
  users: McpUserGroup[];
  /** True for an admin or owner, decided by the server rather than the client. */
  canManage: boolean;
  maxScope: string | null;
  loading: boolean;
  busyId: string | null;
  savingPolicy: boolean;
  revoke: (connection: McpConnectionRow) => Promise<void>;
  setScope: (group: McpUserGroup, scope: string) => Promise<void>;
  setMaxScope: (scope: string | null) => Promise<void>;
};

const EMPTY: McpUserGroup[] = [];

export function useMcpConnections(): McpConnectionsState {
  const { organizationId } = useSettingsContext();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const section = useCachedSection<ConnectionsResponse | null>(
    organizationId ? `mcp-connections:${organizationId}` : null,
    async () => {
      const res = await fetch("/api/mcp/connections");
      return res.ok ? ((await res.json()) as ConnectionsResponse) : null;
    }
  );
  const refetch = section.refetch;

  const revoke = useCallback(
    async (connection: McpConnectionRow): Promise<void> => {
      setBusyId(connection.id);
      try {
        const res = await fetch(
          `/api/mcp/connections/${encodeURIComponent(connection.id)}`,
          { method: "DELETE" }
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(data.error ?? "Could not revoke the connection");
          return;
        }
        toast.success(`Revoked ${connection.clientName}`);
        await refetch();
      } finally {
        setBusyId(null);
      }
    },
    [refetch]
  );

  const setScope = useCallback(
    async (group: McpUserGroup, scope: string): Promise<void> => {
      // Keyed by the person: the limit is theirs, and somebody who has not
      // connected an agent yet has no session to address.
      setBusyId(group.userId);
      try {
        const res = await fetch(
          `/api/mcp/members/${encodeURIComponent(group.userId)}`,
          {
            body: JSON.stringify({ scope }),
            headers: { "Content-Type": "application/json" },
            method: "PATCH",
          }
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(data.error ?? "Could not change the access");
          return;
        }
        // Changing a scope leaves the refresh token working, so the agent
        // renews itself and comes back at the new level. Nobody has to touch
        // the client.
        toast.success("Access updated. The agent picks it up within a minute.");
        await refetch();
      } finally {
        setBusyId(null);
      }
    },
    [refetch]
  );

  const setMaxScope = useCallback(
    async (scope: string | null): Promise<void> => {
      setSavingPolicy(true);
      try {
        const res = await fetch("/api/mcp/policy", {
          body: JSON.stringify({ maxScope: scope }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          affected?: number;
        };
        if (!res.ok) {
          toast.error(data.error ?? "Could not save the policy");
          return;
        }
        // Nothing was rewritten: the ceiling holds those agents down, and
        // their own limits are still whatever was chosen for them.
        toast.success(
          data.affected
            ? `Saved. ${data.affected} agent${data.affected === 1 ? " is" : "s are"} now limited by this.`
            : "Saved"
        );
        await refetch();
      } finally {
        setSavingPolicy(false);
      }
    },
    [refetch]
  );

  return {
    busyId,
    canManage: section.data?.canManage ?? false,
    users: section.data?.users ?? EMPTY,
    loading: section.loading,
    maxScope: section.data?.maxScope ?? null,
    revoke,
    savingPolicy,
    setMaxScope,
    setScope,
  };
}
