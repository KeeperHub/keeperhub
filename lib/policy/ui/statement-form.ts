import {
  draftManagedScopes,
  fromStatement,
  type StatementDraft,
  StatementTarget,
  toStatement,
} from "@/lib/policy/catalog";
import type { SelectorCatalogEntry } from "@/lib/policy/catalog/types";
import {
  DEFAULT_POLICY_NAME,
  POLICY_SCHEMA_VERSION,
  PolicyEffect,
  PolicyEnforcementMode,
} from "@/lib/policy/constants";
import type { PolicyDocument, PolicyLimit } from "@/lib/policy/types";
import { NATIVE_DENOMINATION } from "@/lib/policy/ui/options";

/**
 * How a rule names who it applies to.
 *
 * Exactly one at a time. Conditions inside a statement are combined with AND,
 * so offering roles and a named person together lets someone write "is a member
 * AND is Ada, an admin", which matches nobody and looks like it should match
 * somebody.
 */
export const ActorScope = {
  ANYONE: "anyone",
  ROLES: "roles",
  PEOPLE: "people",
} as const;

export type ActorScope = (typeof ActorScope)[keyof typeof ActorScope];

/**
 * How a rule treats counterparties.
 *
 * The exception is a mode of its own rather than something inferred from an
 * empty list. A set of ticked boxes where unticked means "no restriction" reads
 * as a deny-list and behaves as an allow-list, and there is no way to tell
 * which was meant by looking at it.
 */
export const CounterpartyScope = {
  ANY: "any",
  ONLY: "only",
  EXCEPT: "except",
} as const;

export type CounterpartyScope =
  (typeof CounterpartyScope)[keyof typeof CounterpartyScope];

/**
 * Whether the chosen functions are the ones a rule covers, or the ones it
 * leaves out.
 *
 * "Refuse everything here except withdraw" is a different rule from "refuse
 * withdraw", and without this the second is the only one the form can write.
 */
export const SelectorScope = {
  THESE: "these",
  EXCEPT: "except",
} as const;

export type SelectorScope = (typeof SelectorScope)[keyof typeof SelectorScope];

export type ResourceSelection = {
  chainId: number | null;
  address: string;
  protocolSlug?: string;
  /** Selectors chosen in the picker. Empty means the whole contract. */
  selectors: string[];
  /** Whether those selectors are what the rule covers, or what it carves out. */
  selectorScope: SelectorScope;
};

/** One rule, as the form holds it. */
export type StatementFormValue = {
  sid: string;
  effect: PolicyEffect;
  target: StatementTarget;
  controlCapabilities: string[];
  controlResourceId: string;
  projectIds: string[];
  tagIds: string[];
  actorRoles: string[];
  actorIds: string[];
  actorScope: ActorScope;
  resource: ResourceSelection;
  assets: string[];
  counterparties: string[];
  /** Whether the counterparties listed are the only ones, or the excluded ones. */
  counterpartyScope: CounterpartyScope;
  /** Ceiling per action, in whatever `denomination` counts. */
  maxUsd: string;
  /** Rolling daily budget, in whatever `denomination` counts. */
  dailyUsd: string;
  denomination: string;
};

export function emptyStatement(index: number): StatementFormValue {
  return {
    sid: `rule-${index + 1}`,
    effect: PolicyEffect.ALLOW,
    target: StatementTarget.ONCHAIN,
    controlCapabilities: [],
    controlResourceId: "",
    projectIds: [],
    tagIds: [],
    actorRoles: [],
    actorIds: [],
    actorScope: ActorScope.ANYONE,
    resource: {
      chainId: null,
      address: "",
      selectors: [],
      selectorScope: SelectorScope.THESE,
    },
    assets: [],
    counterparties: [],
    counterpartyScope: CounterpartyScope.ANY,
    maxUsd: "",
    dailyUsd: "",
    denomination: NATIVE_DENOMINATION,
  };
}

/** The scope a stored rule was written with, read back from what it names. */
export function scopeOf(
  roles: readonly string[],
  memberIds: readonly string[]
): ActorScope {
  if (memberIds.length > 0) {
    return ActorScope.PEOPLE;
  }
  return roles.length > 0 ? ActorScope.ROLES : ActorScope.ANYONE;
}

function toLimits(value: StatementFormValue): PolicyLimit[] {
  if (value.dailyUsd.trim().length === 0) {
    return [];
  }
  return [
    {
      metric: "usd",
      window: "1d",
      max: value.dailyUsd.trim(),
      scope: "organization",
    },
  ];
}

export type CatalogEntryMap = Record<string, SelectorCatalogEntry[]>;

export function catalogKey(chainId: number | null, address: string): string {
  return `${chainId ?? 0}:${address.toLowerCase()}`;
}

/** The catalog entries behind the selectors chosen for one rule. */
export function selectedEntries(
  value: StatementFormValue,
  entries: CatalogEntryMap
): SelectorCatalogEntry[] {
  const all =
    entries[catalogKey(value.resource.chainId, value.resource.address)];
  if (!all) {
    return [];
  }
  if (value.resource.selectors.length === 0) {
    return all;
  }
  return all.filter((entry) =>
    value.resource.selectors.includes(entry.selector)
  );
}

export function toDraft(
  value: StatementFormValue,
  entries: CatalogEntryMap
): StatementDraft {
  return {
    sid: value.sid,
    effect: value.effect,
    target: value.target,
    controlCapabilities: value.controlCapabilities,
    controlResourceId: value.controlResourceId,
    projectIds: value.projectIds,
    tagIds: value.tagIds,
    actorRoles: value.actorRoles,
    actorIds: value.actorIds,
    chainId: value.resource.chainId,
    address: value.resource.address,
    selectors: value.resource.selectors,
    entries: selectedEntries(value, entries),
    assets: value.assets,
    counterparties: value.counterparties,
    counterpartyScope: value.counterpartyScope,
    selectorScope: value.resource.selectorScope,
    condition:
      value.maxUsd.trim().length > 0
        ? { usdValue: { lte: value.maxUsd.trim() } }
        : undefined,
    limit: toLimits(value),
  };
}

/**
 * The form values for a stored document, or one empty rule for a new policy.
 *
 * A statement the builder cannot draw is dropped here only because the caller
 * has already refused to open the builder for it; see `unrepresentable`.
 */
export function initialStatements(
  document: PolicyDocument | null
): StatementFormValue[] {
  if (!document) {
    return [emptyStatement(0)];
  }
  const parsed = document.statements
    .map((statement) => fromStatement(statement))
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .map((value) => ({
      ...emptyStatement(0),
      sid: value.sid,
      effect: value.effect,
      target: value.target,
      controlCapabilities: value.controlCapabilities,
      controlResourceId: value.controlResourceId,
      projectIds: value.projectIds,
      tagIds: value.tagIds,
      actorRoles: value.actorRoles,
      actorIds: value.actorIds,
      actorScope: scopeOf(value.actorRoles, value.actorIds),
      resource: {
        chainId: value.chainId,
        address: value.address,
        selectors: value.selectors,
        selectorScope: value.selectorScope as SelectorScope,
      },
      assets: value.assets,
      counterparties: value.counterparties,
      counterpartyScope: value.counterpartyScope,
      maxUsd: value.maxUsd,
      dailyUsd: value.dailyUsd,
    }));
  return parsed.length > 0 ? parsed : [emptyStatement(0)];
}

/** The document a set of form values produces. */
export function buildDocument(input: {
  name: string;
  description: string;
  statements: readonly StatementFormValue[];
  entries: CatalogEntryMap;
}): PolicyDocument {
  const drafts = input.statements.map((value) => toDraft(value, input.entries));
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: input.name || DEFAULT_POLICY_NAME,
    description: input.description.length > 0 ? input.description : undefined,
    enforcement: PolicyEnforcementMode.MONITOR,
    manages: draftManagedScopes(drafts),
    statements: drafts.map(toStatement),
  };
}
