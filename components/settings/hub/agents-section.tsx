"use client";

import {
  AgentFrameworkGroups,
  AgentStarterPrompts,
} from "@/components/agent/connect-agent-panel";
import { ConnectionsTable } from "./agents/connections-table";
import { useMcpConnections } from "./hooks/use-mcp-connections";
import { SectionHeader, SettingsCard } from "./section";

export function AgentsSection(): React.ReactElement {
  const state = useMcpConnections();

  return (
    <>
      <SectionHeader
        description="The MCP clients connected to this organization, and what each one is allowed to do. Clients sign in through the browser, so connecting one needs no API key."
        title="Agents"
      />

      <SettingsCard
        bodyClassName="p-2"
        description={
          state.canManage
            ? "Access belongs to the person, so it holds even if they reconnect. Ending a session cuts off that agent alone. Both take effect within a minute, without waiting for a token to expire."
            : "Your agents. Access is set by an organization admin; you can end any of your own sessions."
        }
        title="Connected agents"
      >
        <ConnectionsTable
          busyId={state.busyId}
          canManage={state.canManage}
          loading={state.loading}
          maxScope={state.maxScope}
          onRevoke={(connection) => {
            state.revoke(connection).catch(() => undefined);
          }}
          onScopeChange={(group, scope) => {
            state.setScope(group, scope).catch(() => undefined);
          }}
          users={state.users}
        />
      </SettingsCard>

      <SettingsCard
        description="Pick your client and run the command it shows."
        title="Client setup"
      >
        <AgentFrameworkGroups />
      </SettingsCard>

      <SettingsCard
        description="Copy one of these into your agent to check the connection."
        title="Starter prompts"
      >
        <AgentStarterPrompts />
      </SettingsCard>
    </>
  );
}
