"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PolicyEffect } from "@/lib/policy";
import { StatementTarget } from "@/lib/policy/catalog";
import {
  type ActorScope,
  EFFECT_OPTIONS,
  type StatementFormValue,
  TARGET_OPTIONS,
} from "@/lib/policy/ui";
import type { ContractEntries } from "../hooks/use-statement-builder";
import { ActorPicker } from "./actor-picker";
import { ControlPlanePicker } from "./control-plane-picker";
import { CounterpartyPicker } from "./counterparty-picker";
import { DenominationField } from "./denomination-field";
import { FieldLabel } from "./field-label";
import { ResourcePicker } from "./resource-picker";
import { RuleSummary } from "./rule-summary";
import { SearchableSelect } from "./searchable-select";

/**
 * One rule.
 *
 * Presentational: every list it offers comes from the shared options module and
 * every value it holds comes from the form model, so it decides nothing about
 * what a policy means.
 */
export function StatementCard({
  value,
  index,
  onChange,
  onRemove,
  onContractLoaded,
}: {
  value: StatementFormValue;
  index: number;
  onChange: (next: StatementFormValue) => void;
  onRemove: () => void;
  onContractLoaded: (contract: ContractEntries) => void;
}): React.ReactElement {
  const isOnchain = value.target === StatementTarget.ONCHAIN;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <RuleSummary value={value} />

      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`sid-${index}`}>Name</Label>
          <Input
            id={`sid-${index}`}
            onChange={(e) => onChange({ ...value, sid: e.target.value })}
            placeholder="what-this-rule-does"
            value={value.sid}
          />
        </div>
        <Button
          aria-label="Remove statement"
          className="mt-6"
          onClick={onRemove}
          size="icon"
          variant="ghost"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel
          hint="Policies cover more than transactions. An onchain rule bounds what a contract call may do. The other options bound what members and agents may change about the organization itself, such as adding a wallet or editing policy."
          htmlFor={`target-${index}`}
        >
          What this rule governs
        </FieldLabel>
        <SearchableSelect
          id={`target-${index}`}
          onChange={(next) =>
            onChange({
              ...value,
              target: next as StatementTarget,
              controlCapabilities: [],
              controlResourceId: "",
              projectIds: [],
              tagIds: [],
            })
          }
          options={TARGET_OPTIONS}
          searchPlaceholder="Search what a rule can govern"
          value={value.target}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel
          hint="Deny always wins over allow, and is the only effect another policy cannot widen. Inside a scope this policy claims, anything no statement allows is denied."
          htmlFor={`effect-${index}`}
        >
          Effect
        </FieldLabel>
        <SearchableSelect
          id={`effect-${index}`}
          onChange={(next) =>
            onChange({ ...value, effect: next as PolicyEffect })
          }
          options={EFFECT_OPTIONS}
          value={value.effect}
        />
      </div>

      <ActorPicker
        index={index}
        memberIds={value.actorIds}
        onMemberIdsChange={(actorIds) => onChange({ ...value, actorIds })}
        onRolesChange={(actorRoles) => onChange({ ...value, actorRoles })}
        onScopeChange={(actorScope: ActorScope) =>
          onChange({ ...value, actorScope })
        }
        roles={value.actorRoles}
        scope={value.actorScope}
      />

      {isOnchain ? (
        <ResourcePicker
          onChange={(resource) => onChange({ ...value, resource })}
          onContractLoaded={onContractLoaded}
          value={value.resource}
        />
      ) : (
        <ControlPlanePicker
          capabilities={value.controlCapabilities}
          index={index}
          onCapabilitiesChange={(controlCapabilities) =>
            onChange({ ...value, controlCapabilities })
          }
          onProjectIdsChange={(projectIds) =>
            onChange({ ...value, projectIds })
          }
          onResourceIdChange={(controlResourceId) =>
            onChange({ ...value, controlResourceId })
          }
          onTagIdsChange={(tagIds) => onChange({ ...value, tagIds })}
          projectIds={value.projectIds}
          resourceId={value.controlResourceId}
          tagIds={value.tagIds}
          target={value.target}
        />
      )}

      {isOnchain && (
        <CounterpartyPicker
          index={index}
          onScopeChange={(counterpartyScope) =>
            onChange({ ...value, counterpartyScope })
          }
          onSelectedChange={(counterparties) =>
            onChange({ ...value, counterparties })
          }
          scope={value.counterpartyScope}
          selected={value.counterparties}
        />
      )}

      {isOnchain && (
        <div className="grid gap-3 sm:grid-cols-2">
          <DenominationField
            amount={value.maxUsd}
            chainId={value.resource.chainId}
            denomination={value.denomination}
            hint="Refuses any single call worth more than this. In dollars the value is priced from an oracle at decision time, never read from what the workflow claims about itself. In a token it is the amount that actually moves."
            id={`max-${index}`}
            label="Most per action"
            onAmountChange={(maxUsd) => onChange({ ...value, maxUsd })}
            onDenominationChange={(denomination) =>
              onChange({ ...value, denomination })
            }
            placeholder="25000"
          />
          <DenominationField
            amount={value.dailyUsd}
            chainId={value.resource.chainId}
            denomination={value.denomination}
            hint="A rolling daily budget across every workflow in the organization. It is reserved before the action and released if the action fails, so two simultaneous calls cannot both slip under the cap."
            id={`daily-${index}`}
            label="Most per day"
            onAmountChange={(dailyUsd) => onChange({ ...value, dailyUsd })}
            onDenominationChange={(denomination) =>
              onChange({ ...value, denomination })
            }
            placeholder="100000"
          />
        </div>
      )}
    </div>
  );
}
