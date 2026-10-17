import {
  STATEMENT_TARGET_LABEL,
  StatementTarget,
} from "@/lib/policy/catalog/control-plane";
import { PolicyEffect } from "@/lib/policy/constants";
import { shortAddress } from "@/lib/policy/ui/options";
import {
  ActorScope,
  CounterpartyScope,
  SelectorScope,
  type StatementFormValue,
} from "@/lib/policy/ui/statement-form";

/** One clause of what a rule does, and whether it narrows or carves out. */
export type RuleClause = {
  text: string;
  /** True when this clause removes something the rule would otherwise cover. */
  exception: boolean;
};

export type RuleSummary = {
  /** Allows or refuses, for a caller that shows it separately. */
  verb: string;
  /** What the rule acts on, without the verb. */
  headline: string;
  /** What narrows it, and what is carved out of it. */
  clauses: RuleClause[];
};

/** Handles the -y plural, so "counterparties" does not read as "counterpartys". */
function plural(count: number, one: string): string {
  if (count === 1) {
    return `1 ${one}`;
  }
  const many = one.endsWith("y") ? `${one.slice(0, -1)}ies` : `${one}s`;
  return `${count} ${many}`;
}

function whoClause(value: StatementFormValue): RuleClause | null {
  if (value.actorScope === ActorScope.ROLES && value.actorRoles.length > 0) {
    return {
      text: `only for ${value.actorRoles.join(" and ")}`,
      exception: false,
    };
  }
  if (value.actorScope === ActorScope.PEOPLE && value.actorIds.length > 0) {
    return { text: "only for one named person", exception: false };
  }
  return null;
}

function functionClause(value: StatementFormValue): RuleClause | null {
  const count = value.resource.selectors.length;
  if (count === 0) {
    return null;
  }
  if (value.resource.selectorScope === SelectorScope.EXCEPT) {
    return { text: `except ${plural(count, "function")}`, exception: true };
  }
  return { text: `on ${plural(count, "function")}`, exception: false };
}

function counterpartyClause(value: StatementFormValue): RuleClause | null {
  const count = value.counterparties.length;
  if (count === 0 || value.counterpartyScope === CounterpartyScope.ANY) {
    return null;
  }
  if (value.counterpartyScope === CounterpartyScope.EXCEPT) {
    return { text: `except ${plural(count, "counterparty")}`, exception: true };
  }
  return { text: `only to ${plural(count, "counterparty")}`, exception: false };
}

function limitClause(value: StatementFormValue): RuleClause | null {
  const per = value.maxUsd.trim();
  const daily = value.dailyUsd.trim();
  if (!(per || daily)) {
    return null;
  }
  const parts = [
    per ? `at most ${per} per action` : null,
    daily ? `${daily} per day` : null,
  ].filter(Boolean);
  return { text: parts.join(", "), exception: false };
}

function subject(value: StatementFormValue): string {
  if (value.target !== StatementTarget.ONCHAIN) {
    const label = STATEMENT_TARGET_LABEL[value.target].toLowerCase();
    const count = value.controlCapabilities.length;
    return count === 0
      ? `actions on ${label}`
      : `${plural(count, "action")} on ${label}`;
  }
  if (value.resource.address) {
    return `calls to ${shortAddress(value.resource.address)}`;
  }
  if (value.resource.chainId) {
    return `calls on chain ${value.resource.chainId}`;
  }
  return "calls";
}

/**
 * What a rule does, in a sentence.
 *
 * An exception is only visible in the document or inside a dropdown, and a rule
 * that quietly excludes something is exactly the kind a reader needs to see
 * without opening anything. The clauses are separated so the exceptions can be
 * shown as what they are rather than blended into prose.
 */
export function describeStatement(value: StatementFormValue): RuleSummary {
  const verb = value.effect === PolicyEffect.DENY ? "Refuses" : "Allows";
  const clauses = [
    whoClause(value),
    functionClause(value),
    counterpartyClause(value),
    limitClause(value),
  ].filter((clause): clause is RuleClause => clause !== null);

  return { verb, headline: subject(value), clauses };
}
