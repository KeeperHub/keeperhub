import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Box } from "lucide-react";
import "@/protocols";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import {
  getRegisteredProtocols,
  type ProtocolActionInput,
  type ProtocolDefinition,
} from "@/lib/protocol-registry";
import type { IntegrationType } from "@/lib/types/integration";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";
import {
  flattenConfigFields,
  getIntegration,
  type PluginAction,
} from "@/plugins/registry";
import { ProtocolDetailIsland } from "./_protocol-detail-island";
import { ProtocolGridClient } from "./_protocols-grid-client";

// hubOnly protocols (e.g., Hyperliquid) carry no protocol-registry actions —
// their runtime actions live in a plugin sharing the same slug. Surface those
// plugin actions in the Hub card + detail modal so the protocol reads as
// first-class instead of "Coming soon". The synthesized ProtocolActions reuse
// the plugin slug, so "Use in workflow" resolves to the real plugin action id
// (e.g., hyperliquid/clearinghouse-state).
function pluginActionInputs(action: PluginAction): ProtocolActionInput[] {
  return flattenConfigFields(action.configFields)
    .filter((field) => field.required)
    .map((field) => ({
      name: field.key,
      type: field.isAddressField ? "address" : "string",
      label: field.label,
    }));
}

function withPluginActions(protocol: ProtocolDefinition): ProtocolDefinition {
  if (!protocol.hubOnly) {
    return protocol;
  }
  const plugin = getIntegration(protocol.slug as IntegrationType);
  if (!plugin || plugin.actions.length === 0) {
    return protocol;
  }
  return {
    ...protocol,
    actions: plugin.actions.map((action) => ({
      slug: action.slug,
      label: action.label,
      description: action.description,
      type: "read" as const,
      contract: "",
      function: "",
      inputs: pluginActionInputs(action),
    })),
  };
}

async function fetchProtocolWorkflowCounts(): Promise<Record<string, number>> {
  // Mirrors /api/workflows/public?featuredProtocol=<slug> visibility filter
  // (public + non-null featured slug). Single GROUP BY — protocol count is
  // small, no pagination needed.
  const rows = await db
    .select({
      slug: workflows.featuredProtocol,
      count: sql<number>`count(*)::int`,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.visibility, "public"),
        isNotNull(workflows.featuredProtocol),
        workflowNotDeleted()
      )
    )
    .groupBy(workflows.featuredProtocol);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.slug) {
      counts[row.slug] = row.count;
    }
  }
  return counts;
}

type HubProtocolsTabProps = {
  query: string;
};

function matchesQuery(protocol: ProtocolDefinition, q: string): boolean {
  const haystack =
    `${protocol.name} ${protocol.description ?? ""}`.toLowerCase();
  return haystack.includes(q);
}

export async function HubProtocolsTab({
  query,
}: HubProtocolsTabProps): Promise<React.ReactElement> {
  // Read from the in-process registry — same source the /api/protocols route
  // serves. Avoids an HTTP hop for the SSR render and keeps the data path
  // independent of the Workflows tab (per CONTEXT.md "no coupling").
  const all = getRegisteredProtocols().map(withPluginActions);
  const trimmed = query.trim().toLowerCase();
  const protocols =
    trimmed === "" ? all : all.filter((p) => matchesQuery(p, trimmed));

  if (all.length === 0) {
    return (
      <section
        aria-label="Protocols"
        className="flex flex-col items-center rounded-xl border border-border/30 border-dashed bg-[var(--color-hub-card)] p-12 text-center"
      >
        <Box aria-hidden="true" className="size-8 text-muted-foreground/50" />
        <h2 className="mt-4 font-semibold text-foreground text-sm">
          No protocols available yet.
        </h2>
        <p className="mt-1 text-muted-foreground text-xs">
          Protocols are added by the KeeperHub team. Check back soon.
        </p>
      </section>
    );
  }

  if (protocols.length === 0) {
    return (
      <section
        aria-label="Protocols"
        className="flex flex-col items-center rounded-xl border border-border/30 border-dashed bg-[var(--color-hub-card)] p-12 text-center"
      >
        <Box aria-hidden="true" className="size-8 text-muted-foreground/50" />
        <h2 className="mt-4 font-semibold text-foreground text-sm">
          No protocols match “{query}”.
        </h2>
        <p className="mt-1 text-muted-foreground text-xs">
          Try a different keyword or clear the search.
        </p>
      </section>
    );
  }

  const workflowCounts = await fetchProtocolWorkflowCounts();

  return (
    <>
      <ProtocolGridClient
        protocols={protocols}
        workflowCounts={workflowCounts}
      />
      <ProtocolDetailIsland protocols={all} />
    </>
  );
}
