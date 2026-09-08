import {
  ARN_WILDCARD_DEEP,
  ARN_WILDCARD_SEGMENT,
  ArnSegment,
  buildArn,
  buildContractCallArn,
} from "@/lib/policy";
import type { Capability } from "@/lib/policy/capabilities";
import { isOnchainCapability } from "@/lib/policy/capabilities";

import { describeResource as describeArn } from "@/lib/policy/catalog/compatibility";
import {
  PolicyRiskClass,
  RISK_CLASS_CAPABILITIES,
} from "@/lib/policy/catalog/constants";
import {
  buildControlManagedScope,
  buildControlResourceArn,
  StatementTarget,
  targetForCapability,
} from "@/lib/policy/catalog/control-plane";
import type { SelectorCatalogEntry } from "@/lib/policy/catalog/types";
import type { PolicyEffect } from "@/lib/policy/constants";
import { PolicyConditionKey } from "@/lib/policy/constants";
import type {
  PolicyCondition,
  PolicyConditionMap,
  PolicyLimit,
  PolicyStatement,
} from "@/lib/policy/types";

export type StatementDraft = {
  sid: string;
  effect: PolicyEffect;
  /** Which plane this rule governs. Defaults to an onchain call. */
  target?: StatementTarget;
  /** Control-plane capabilities chosen for a non-onchain target. */
  controlCapabilities?: readonly string[];
  /** A single resource id, or empty for every resource of that kind. */
  controlResourceId?: string;
  /** Projects the rule is limited to. Empty means every project. */
  projectIds?: readonly string[];
  /** Tags the rule is limited to. Empty means every tag. */
  tagIds?: readonly string[];
  /** Roles the rule applies to. Empty means every role. */
  actorRoles?: readonly string[];
  /** Specific people the rule applies to. Empty means everyone. */
  actorIds?: readonly string[];
  chainId: number | null;
  address: string;
  /** Selectors chosen in the picker. Empty means the whole contract. */
  selectors: readonly string[];
  /** Catalog entries for the chosen selectors, for capability derivation. */
  entries: readonly SelectorCatalogEntry[];
  /** Asset identifiers the statement is limited to. Empty means any. */
  assets?: readonly string[];
  /** Counterparty identifiers the statement names. Empty means any. */
  counterparties?: readonly string[];
  /** Whether those counterparties are the only ones allowed, or the excluded ones. */
  counterpartyScope?: "any" | "only" | "except";
  /** Whether the selectors are the functions covered, or the ones carved out. */
  selectorScope?: "these" | "except";
  condition?: PolicyConditionMap;
  limit?: readonly PolicyLimit[];
};

/**
 * The `none` sentinel a null selector produces means empty calldata, not any
 * function. A contract-wide rule that used it would claim only bare native
 * transfers and leave every real call unmanaged, so these builders write the
 * function segment explicitly instead.
 */

/** Every contract on one chain, with the function segment left open. */
function chainWideArn(chainId: number): string {
  return buildArn([
    { type: ArnSegment.CHAIN, id: String(chainId) },
    { type: ArnSegment.CONTRACT, id: ARN_WILDCARD_SEGMENT },
    { type: ArnSegment.FUNCTION, id: ARN_WILDCARD_SEGMENT },
  ]);
}

/** One contract, with the function segment left open. */
function contractWideArn(chainId: number, address: string): string {
  return buildArn([
    { type: ArnSegment.CHAIN, id: String(chainId) },
    { type: ArnSegment.CONTRACT, id: address },
    { type: ArnSegment.FUNCTION, id: ARN_WILDCARD_SEGMENT },
  ]);
}

/**
 * The scopes below use the deep wildcard, which the grammar only accepts as a
 * trailing segment of its own. Writing it as a function id (".../fn/**")
 * produces an identifier that does not parse, and a managed scope that does not
 * parse is neither a resource nor a capability, so the whole policy is refused
 * at compile time.
 */
function deepChainScope(chainId: number): string {
  return `${buildArn([{ type: ArnSegment.CHAIN, id: String(chainId) }])}/${ARN_WILDCARD_DEEP}`;
}

function deepContractScope(chainId: number, address: string): string {
  return `${buildArn([
    { type: ArnSegment.CHAIN, id: String(chainId) },
    { type: ArnSegment.CONTRACT, id: address },
  ])}/${ARN_WILDCARD_DEEP}`;
}

/**
 * Resource identifiers for a draft.
 *
 * One identifier per selected function, so each is concrete and checkable. No
 * selection means the rule covers the contract, which is written as an open
 * function segment rather than by enumerating every selector: enumerating would
 * silently stop covering a function added by an implementation upgrade.
 */
export function draftResources(draft: StatementDraft): string[] {
  const target = draft.target ?? StatementTarget.ONCHAIN;
  // An offchain action names no resource the identifier grammar can hold, so
  // the statement is governed by its capability alone.
  if (target === StatementTarget.OFFCHAIN) {
    return [];
  }
  if (target !== StatementTarget.ONCHAIN) {
    return [buildControlResourceArn(target, draft.controlResourceId)];
  }
  if (!draft.chainId) {
    return [];
  }
  // A chain with no contract yet still says something: any contract on that
  // chain. Emitting nothing would lose the chain the moment the document round
  // trips through the text view.
  if (draft.address.length === 0) {
    return [chainWideArn(draft.chainId)];
  }
  // Carving functions out keeps the resource contract-wide: the rule is about
  // the whole contract, with the named functions removed by a condition. Pinning
  // the resource to them would say the opposite.
  if (draft.selectors.length === 0 || draft.selectorScope === "except") {
    return [contractWideArn(draft.chainId, draft.address)];
  }
  return draft.selectors.map((selector) =>
    buildContractCallArn({
      chainId: draft.chainId as number,
      contractAddress: draft.address,
      selector,
    })
  );
}

/** The capabilities implied by the selection, deduplicated. */
export function draftCapabilities(draft: StatementDraft): string[] {
  const target = draft.target ?? StatementTarget.ONCHAIN;
  if (target !== StatementTarget.ONCHAIN) {
    return [...(draft.controlCapabilities ?? [])];
  }

  // Each selected function names its own capability, read from the contract's
  // ABI. Falling back to the risk class would say "a contract write" where the
  // catalog knows it is a lending supply, and a rule about lending would then
  // not match the very function the author picked.
  if (draft.entries.length === 0) {
    return [...RISK_CLASS_CAPABILITIES[PolicyRiskClass.UNKNOWN]];
  }

  const capabilities = new Set<string>();
  for (const entry of draft.entries) {
    capabilities.add(entry.capability);
    // The plain form as well. At decision time the semantic capability is read
    // from the same catalog, and where that cannot be reached the request
    // carries the plain one instead. Listing only the semantic form would let a
    // rule stop matching the exact function it names, silently, because a
    // lookup failed. The resource still pins which function this is about, so
    // naming both widens the verb and not the reach.
    for (const base of RISK_CLASS_CAPABILITIES[entry.riskClass]) {
      capabilities.add(base);
    }
  }
  return [...capabilities];
}

/** Turn a draft into the statement the document stores. */
export function toStatement(draft: StatementDraft): PolicyStatement {
  const condition: PolicyConditionMap = { ...draft.condition };
  if (draft.assets?.length) {
    condition[PolicyConditionKey.ASSET] = { in: [...draft.assets] };
  }
  if (draft.counterparties?.length) {
    // An exception is written as the negation it is, so the document says what
    // the form said rather than leaving the reader to infer it.
    condition[PolicyConditionKey.COUNTERPARTY] =
      draft.counterpartyScope === "except"
        ? { notIn: [...draft.counterparties] }
        : { in: [...draft.counterparties] };
  }
  if (draft.selectorScope === "except" && draft.selectors.length > 0) {
    condition[PolicyConditionKey.SELECTOR] = { notIn: [...draft.selectors] };
  }
  if (draft.projectIds?.length) {
    condition[PolicyConditionKey.PROJECT_ID] = { in: [...draft.projectIds] };
  }
  if (draft.tagIds?.length) {
    condition[PolicyConditionKey.WORKFLOW_TAG] = { in: [...draft.tagIds] };
  }
  if (draft.actorRoles?.length) {
    condition[PolicyConditionKey.ACTOR_ROLE] = { in: [...draft.actorRoles] };
  }
  if (draft.actorIds?.length) {
    condition[PolicyConditionKey.ACTOR_ID] = { in: [...draft.actorIds] };
  }

  const statement: PolicyStatement = {
    sid: draft.sid,
    effect: draft.effect,
    capability: draftCapabilities(draft),
    resource: draftResources(draft),
  };
  if (Object.keys(condition).length > 0) {
    statement.condition = condition;
  }
  if (draft.limit?.length) {
    statement.limit = draft.limit;
  }
  return statement;
}

/** The plain values the builder form holds for one statement. */
export type ParsedStatement = {
  sid: string;
  effect: PolicyEffect;
  target: StatementTarget;
  controlCapabilities: string[];
  controlResourceId: string;
  projectIds: string[];
  tagIds: string[];
  actorRoles: string[];
  actorIds: string[];
  chainId: number | null;
  address: string;
  selectors: string[];
  assets: string[];
  counterparties: string[];
  counterpartyScope: "any" | "only" | "except";
  selectorScope: "these" | "except";
  /** Ceiling per action, as a decimal string. Empty when unset. */
  maxUsd: string;
  /** Rolling daily ceiling, as a decimal string. Empty when unset. */
  dailyUsd: string;
};

/**
 * Reads a counterparty condition back, keeping which way round it was written.
 *
 * "only these" and "anything but these" are different rules and the form has to
 * show the one that was saved.
 */
function readCounterparties(condition: PolicyCondition | undefined): {
  values: string[];
  scope: "any" | "only" | "except";
} {
  const excluded = condition?.notIn;
  if (Array.isArray(excluded) && excluded.length > 0) {
    return { values: [...excluded], scope: "except" };
  }
  const allowed = condition?.in;
  if (Array.isArray(allowed) && allowed.length > 0) {
    return { values: [...allowed], scope: "only" };
  }
  return { values: [], scope: "any" };
}

function readStringList(condition: PolicyCondition | undefined): string[] {
  const value = condition?.in;
  return Array.isArray(value) ? [...value] : [];
}

/** The id a control-plane identifier pins, or empty when it covers them all. */
function readControlResourceId(resource: string | undefined): string {
  if (!resource) {
    return "";
  }
  const id = resource.split("/")[1] ?? "";
  return id === "*" || id === "**" ? "" : id;
}

function readCeiling(condition: PolicyCondition | undefined): string {
  const value = condition?.lte;
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

/**
 * Read a stored statement back into the form the builder edits.
 *
 * Returns null when the statement cannot be shown, which the caller turns into
 * a message naming the reason and a fall back to the source editor. Without
 * this, opening a saved policy in the builder would present an empty form and
 * overwrite the policy on save.
 */
export function fromStatement(
  statement: PolicyStatement
): ParsedStatement | null {
  if (unrepresentable(statement)) {
    return null;
  }

  const resources = statement.resource ?? [];
  const [first] = resources;

  const offchain =
    statement.capability.length > 0 &&
    statement.capability.every(
      (capability) =>
        !isOnchainCapability(capability as Capability) &&
        targetForCapability(capability) === null
    );

  const controlTarget = offchain
    ? StatementTarget.OFFCHAIN
    : statement.capability
        .map((capability) => targetForCapability(capability))
        .find((target): target is StatementTarget => target !== null);

  if (controlTarget) {
    return {
      sid: statement.sid,
      effect: statement.effect,
      target: controlTarget,
      controlCapabilities: [...statement.capability],
      controlResourceId: readControlResourceId(first),
      projectIds: readStringList(
        statement.condition?.[PolicyConditionKey.PROJECT_ID]
      ),
      tagIds: readStringList(
        statement.condition?.[PolicyConditionKey.WORKFLOW_TAG]
      ),
      actorRoles: readStringList(
        statement.condition?.[PolicyConditionKey.ACTOR_ROLE]
      ),
      actorIds: readStringList(
        statement.condition?.[PolicyConditionKey.ACTOR_ID]
      ),
      chainId: null,
      address: "",
      selectors: [],
      assets: [],
      counterparties: [],
      counterpartyScope: "any",
      selectorScope: "these",
      maxUsd: readCeiling(statement.condition?.[PolicyConditionKey.USD_VALUE]),
      dailyUsd: "",
    };
  }

  const counterparty = readCounterparties(
    statement.condition?.[PolicyConditionKey.COUNTERPARTY]
  );
  const described = describeArn(first);

  // A carve-out lives in the condition, not the resource, so the functions are
  // read back from there when one is present.
  const carved = readStringList(
    statement.condition?.[PolicyConditionKey.SELECTOR]
  );
  const selectors =
    carved.length > 0
      ? carved
      : resources
          .map((resource) => describeArn(resource).selector)
          .filter((selector): selector is string => selector !== null);

  const dailyLimit = statement.limit?.find(
    (limit) => limit.metric === "usd" && limit.window === "1d"
  );

  return {
    sid: statement.sid,
    effect: statement.effect,
    target: StatementTarget.ONCHAIN,
    controlCapabilities: [],
    controlResourceId: "",
    projectIds: [],
    tagIds: [],
    actorRoles: readStringList(
      statement.condition?.[PolicyConditionKey.ACTOR_ROLE]
    ),
    actorIds: readStringList(
      statement.condition?.[PolicyConditionKey.ACTOR_ID]
    ),
    chainId: described.chainId,
    address: described.address ?? "",
    selectors,
    assets: readStringList(statement.condition?.[PolicyConditionKey.ASSET]),
    counterparties: counterparty.values,
    counterpartyScope: counterparty.scope,
    selectorScope: carved.length > 0 ? "except" : "these",
    maxUsd: readCeiling(statement.condition?.[PolicyConditionKey.USD_VALUE]),
    dailyUsd: dailyLimit?.max ?? "",
  };
}

/**
 * The scopes a set of drafts claims authority over.
 *
 * Contract-level, not selector-level, and that difference is the whole point:
 * claiming only the functions a statement allows would leave every other
 * function on the same contract unmanaged and therefore permitted. Claiming the
 * contract makes anything not allowed inside it denied, which is what an author
 * choosing "allow supply and withdraw" actually means.
 */
export function draftManagedScopes(
  drafts: readonly StatementDraft[]
): string[] {
  const scopes = new Set<string>();
  for (const draft of drafts) {
    const target = draft.target ?? StatementTarget.ONCHAIN;
    // An offchain rule claims the capabilities it names, since there is no
    // resource to claim. `manages` accepts capability patterns for exactly this.
    if (target === StatementTarget.OFFCHAIN) {
      for (const capability of draft.controlCapabilities ?? []) {
        scopes.add(capability);
      }
      continue;
    }
    if (target !== StatementTarget.ONCHAIN) {
      scopes.add(buildControlManagedScope(target));
      continue;
    }
    if (!draft.chainId) {
      continue;
    }
    scopes.add(
      draft.address.length === 0
        ? deepChainScope(draft.chainId)
        : deepContractScope(draft.chainId, draft.address)
    );
  }
  return [...scopes];
}

/**
 * The only condition keys the builder can edit.
 *
 * A statement carrying anything else must not open in the builder: the form
 * would not show it, and saving would drop it. Naming the key and falling back
 * to the source editor is the difference between a limitation and data loss.
 */
const BUILDER_CONDITION_KEYS: readonly string[] = [
  PolicyConditionKey.ASSET,
  PolicyConditionKey.COUNTERPARTY,
  PolicyConditionKey.USD_VALUE,
  PolicyConditionKey.PROJECT_ID,
  PolicyConditionKey.WORKFLOW_TAG,
  PolicyConditionKey.ACTOR_ROLE,
  PolicyConditionKey.ACTOR_ID,
  PolicyConditionKey.SELECTOR,
];

/** The only limit shape the builder can edit: a rolling daily dollar cap. */
function isBuilderLimit(limit: PolicyLimit): boolean {
  return (
    limit.metric === "usd" &&
    limit.window === "1d" &&
    limit.scope === "organization"
  );
}

/** Why a stored statement cannot be shown in the builder. */
export type UnrepresentableReason = {
  sid: string;
  reason: string;
};

/**
 * Check whether a stored statement can be rendered by the builder.
 *
 * Returns null when it can. The builder never refuses to open a policy: an
 * unrepresentable statement sends the author to the source editor with this
 * reason named, rather than with a generic failure.
 */
export function unrepresentable(
  statement: PolicyStatement
): UnrepresentableReason | null {
  // An empty resource list is not a problem to report. An offchain rule names
  // no resource by design, and an onchain rule whose contract has not been
  // chosen yet is simply unfinished: refusing it here wiped every half-built
  // rule the moment the author looked at the text view.
  const resources = statement.resource ?? [];

  const contracts = new Set(
    resources.map((resource) => resource.split("/fn/")[0])
  );
  if (contracts.size > 1) {
    return {
      sid: statement.sid,
      reason:
        "it spans more than one contract, and the builder shows one contract per statement",
    };
  }

  if (statement.counterparty?.length) {
    return {
      sid: statement.sid,
      reason: "it constrains counterparties, which the builder cannot yet edit",
    };
  }

  if (statement.postcondition) {
    return {
      sid: statement.sid,
      reason: "it carries a postcondition, which the builder cannot yet edit",
    };
  }

  const foreignKeys = Object.keys(statement.condition ?? {}).filter(
    (key) => !BUILDER_CONDITION_KEYS.includes(key)
  );
  if (foreignKeys.length > 0) {
    return {
      sid: statement.sid,
      reason: `it uses ${foreignKeys.join(", ")}, which the builder cannot yet edit`,
    };
  }

  const foreignLimits = (statement.limit ?? []).filter(
    (limit) => !isBuilderLimit(limit)
  );
  if (foreignLimits.length > 0) {
    return {
      sid: statement.sid,
      reason:
        "it carries a limit the builder cannot edit, which only handles a rolling daily dollar cap",
    };
  }

  return null;
}
