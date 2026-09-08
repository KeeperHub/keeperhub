"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsCard } from "../section";
import { DenominationField } from "./builder/denomination-field";
import { FieldLabel } from "./builder/field-label";
import { ResourcePicker } from "./builder/resource-picker";
import { SearchableSelect } from "./builder/searchable-select";
import {
  type SimulationResult,
  usePolicySimulation,
} from "./hooks/use-policy-simulation";

function Verdict({ result }: { result: SimulationResult }): React.ReactElement {
  if (result.error) {
    return <p className="text-destructive text-xs">{result.error}</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.wouldBlock ? "destructive" : "secondary"}>
          {result.wouldBlock ? "Blocked" : "Allowed"}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {result.outcome} / {result.reason}
        </span>
        {result.observedOnly && <Badge variant="outline">Monitor only</Badge>}
      </div>
      {result.message && (
        <p className="text-muted-foreground text-xs">{result.message}</p>
      )}
      {result.matched && result.matched.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Decided by{" "}
          <span className="font-mono">
            {result.matched.map((m) => m.sid).join(", ")}
          </span>
        </p>
      ) : (
        result.wouldBlock && (
          // An implicit deny has no statement to name, and must not look like
          // one that fired.
          <p className="text-muted-foreground text-xs">
            No statement matched. This scope is managed, so anything not allowed
            inside it is denied.
          </p>
        )
      )}
    </div>
  );
}

/**
 * Ask what would happen, without doing it.
 *
 * Presentational: which questions an action needs is decided in
 * `usePolicySimulation`, so a field that is hidden is also one that is not sent.
 */
export function PolicySimulator(): React.ReactElement {
  const sim = usePolicySimulation();

  return (
    <SettingsCard
      description="Check one action against the policies above before anything depends on them."
      title="Simulate"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <FieldLabel
            hint="The kind of action to test. Everything below follows from it: an onchain action asks for a chain, then a contract, then a value; an offchain one asks for none of them."
            htmlFor="sim-capability"
          >
            Action
          </FieldLabel>
          <SearchableSelect
            id="sim-capability"
            onChange={sim.setCapability}
            options={sim.actionOptions}
            placeholder="Choose an action"
            searchPlaceholder="Search actions"
            value={sim.capability}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel
            hint="Who performs the action. Every rule about the organization turns on this: the same action is often allowed for an owner and refused for a member. Pick a role to test the rule without naming anyone."
            htmlFor="sim-actor"
          >
            Acting as
          </FieldLabel>
          <SearchableSelect
            id="sim-actor"
            onChange={sim.setActor}
            options={sim.actorChoices}
            placeholder="Choose a role or a member"
            searchPlaceholder="Search roles and members"
            value={sim.actor}
          />
        </div>

        {sim.isOnchain && (
          <ResourcePicker
            onChange={sim.setSelection}
            onContractLoaded={() => undefined}
            value={sim.selection}
          />
        )}

        {sim.movesValue && (
          <DenominationField
            amount={sim.amount}
            chainId={sim.selection.chainId}
            denomination={sim.denomination}
            hint="What the action would move. In dollars the value is priced from an oracle at decision time. In a token it is the amount of that token. Leave it empty to test whether the action is permitted at all, before any limit applies."
            id="sim-amount"
            label="Value (optional)"
            onAmountChange={sim.setAmount}
            onDenominationChange={sim.setDenomination}
            placeholder="25000"
          />
        )}

        {sim.namesResource && (
          <div className="flex flex-col gap-1.5">
            <FieldLabel
              hint="Which resource the action targets. Leave it empty to test the rule as it applies to every one of them."
              htmlFor="sim-resource-id"
            >
              Which one (optional)
            </FieldLabel>
            {sim.resourceChoices.length > 0 ? (
              <SearchableSelect
                id="sim-resource-id"
                onChange={sim.setResourceId}
                options={sim.resourceChoices}
                placeholder="Every one of them"
                searchPlaceholder="Search"
                value={sim.resourceId}
              />
            ) : (
              <Input
                id="sim-resource-id"
                onChange={(e) => sim.setResourceId(e.target.value)}
                placeholder="Every one of them"
                value={sim.resourceId}
              />
            )}
          </div>
        )}

        {!(sim.isOnchain || sim.namesResource) && (
          <p className="text-muted-foreground text-xs">
            {sim.isCreate
              ? "This action creates something, so there is no existing resource to name. It is governed by who is acting, when, and how often."
              : "This action touches no chain and names no organization resource, so there is nothing further to describe. It is governed by who is acting, when, and how often."}
          </p>
        )}

        <div>
          <Button disabled={sim.running} onClick={sim.run} size="sm">
            {sim.running ? "Checking..." : "Check"}
          </Button>
        </div>

        {sim.unavailable && (
          <p className="text-destructive text-xs">
            The policy service could not be read, so this result is not a
            verdict. Actions fail closed while that is true.
          </p>
        )}

        {sim.results === null && (
          <p className="text-muted-foreground text-xs">
            Not simulated yet. Nothing is sent and no chain is read.
          </p>
        )}

        {sim.stale && sim.results !== null && (
          <p className="text-muted-foreground text-xs">
            The request changed since this result. Run it again.
          </p>
        )}

        {sim.results?.map((result) => (
          <div className="rounded-lg border p-3" key={result.nodeId}>
            <Verdict result={result} />
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}
