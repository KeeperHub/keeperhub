"use client";

import Link from "next/link";
import { useState } from "react";
import { Pager } from "@/components/activity/pager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { SettingsCard } from "../section";
import { useSettingsContext } from "../settings-context";
import {
  type Decision,
  usePolicyDecisions,
} from "./hooks/use-policy-decisions";
import { Identifier } from "./policy-overview";

/**
 * What the policies actually did.
 *
 * Only governed decisions are recorded, so this is the interesting subset
 * rather than a log of everything that ran. In monitor mode it is the whole
 * point: it shows what would have been blocked before anything is.
 */
function DecisionRow({
  decision,
  organizationId,
}: {
  decision: Decision;
  organizationId: string | null;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={decision.outcome === "deny" ? "destructive" : "secondary"}
          >
            {decision.outcome}
          </Badge>
          <span className="font-mono text-xs">{decision.capability}</span>
          {decision.observedOnly && (
            <Badge variant="outline">Monitor only</Badge>
          )}
        </div>
        {decision.resource && (
          <Identifier
            organizationId={organizationId}
            value={decision.resource}
          />
        )}
        <span className="truncate text-muted-foreground text-xs">
          {decision.reason}
          {decision.matchedSids?.length
            ? ` (${decision.matchedSids.join(", ")})`
            : ""}
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className="text-muted-foreground text-xs">
          {new Date(decision.createdAt).toLocaleString()}
        </span>
        {decision.workflowId && (
          <Link
            className="text-xs underline underline-offset-2 hover:text-foreground"
            href={`/workflows/${decision.workflowId}`}
          >
            View workflow
          </Link>
        )}
      </div>
    </div>
  );
}

function DecisionList({
  decisions,
  loading,
  emptyMessage,
  organizationId,
}: {
  decisions: Decision[] | null;
  loading: boolean;
  emptyMessage: string;
  organizationId: string | null;
}): React.ReactElement {
  if (decisions === null || (loading && decisions.length === 0)) {
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }
  if (decisions.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyMessage}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {decisions.map((decision) => (
        <DecisionRow
          decision={decision}
          key={decision.id}
          organizationId={organizationId}
        />
      ))}
    </div>
  );
}

/**
 * The decisions one policy made, shown inside that policy's own card.
 *
 * Scoped by policy id rather than filtered in the browser, so a policy with a
 * long history costs the same to open as a new one.
 */
export function PolicyDecisionsForPolicy({
  policyId,
}: {
  policyId: string;
}): React.ReactElement {
  const { organizationId } = useSettingsContext();
  const [page, setPage] = useState(1);
  const { decisions, meta, loading } = usePolicyDecisions({ policyId, page });

  return (
    <div className="flex flex-col gap-2">
      <DecisionList
        decisions={decisions}
        emptyMessage="This policy has not decided anything yet."
        loading={loading}
        organizationId={organizationId}
      />
      <Pager meta={meta} onPage={setPage} unit="decisions" />
    </div>
  );
}

/**
 * Decisions whose governing policy is gone.
 *
 * A deleted policy does not take its history with it, so these rows would
 * otherwise have nowhere to appear. They sit at the bottom because they are
 * evidence rather than something anyone still edits.
 */
export function PolicyDecisions(): React.ReactElement {
  const { organizationId } = useSettingsContext();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const debouncedQuery = useDebounce(query, 200);
  const { decisions, meta, loading, refresh } = usePolicyDecisions({
    orphaned: true,
    query: debouncedQuery,
    page,
  });

  return (
    <SettingsCard
      action={
        <Button
          disabled={loading}
          onClick={() => refresh()}
          size="sm"
          variant="ghost"
        >
          Refresh
        </Button>
      }
      description="Decisions that no longer have a policy to sit under, because the policy was deleted or because nothing governed the action. They are kept so the record survives the rule that made it."
      title="Decisions without a policy"
    >
      <div className="flex flex-col gap-3">
        <Input
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder="Search by capability, resource, or reason"
          value={query}
        />
        <DecisionList
          decisions={decisions}
          emptyMessage={
            debouncedQuery
              ? "No decisions match that search."
              : "Nothing here. Every recorded decision still has its policy."
          }
          loading={loading}
          organizationId={organizationId}
        />
        <Pager meta={meta} onPage={setPage} unit="decisions" />
      </div>
    </SettingsCard>
  );
}
