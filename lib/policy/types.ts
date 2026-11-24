/**
 * Shared policy interfaces. Types only, no runtime values, so this is safe to
 * import from client components, `"use step"` plugin files, edge middleware and
 * the standalone executor alike.
 *
 * Anything appearing in more than one module belongs here rather than being
 * redeclared. Runtime enum values live in ./constants; capability identifiers in
 * ./capabilities; identifier parsing in ./arn.
 */

import type { Capability } from "./capabilities";
import type {
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PolicyConditionKey,
  PolicyDecisionReason,
  PolicyEffect,
  PolicyEnforcementMode,
  PolicyLimitMetric,
  PolicyLimitScope,
  PolicyLimitWindow,
  PolicyOperator,
  PolicyOutcome,
  PolicyPostconditionKey,
  PolicyRole,
  PolicySignalKey,
  PrincipalKind,
} from "./constants";

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/**
 * Who is acting. Org-scoped principals carry a role so the existing role model
 * stays total rather than gaining a second, parallel one; an API key or OAuth
 * grant is assigned a role at creation, defaulting to the least privileged.
 */
export type Principal =
  | {
      kind: typeof PrincipalKind.MEMBER;
      userId: string;
      organizationId: string;
      role: PolicyRole;
    }
  | {
      kind: typeof PrincipalKind.API_KEY;
      apiKeyId: string;
      organizationId: string;
      role: PolicyRole;
      scope?: string;
    }
  | {
      kind: typeof PrincipalKind.OAUTH;
      userId: string;
      organizationId: string;
      role: PolicyRole;
      scope: string;
    }
  | { kind: typeof PrincipalKind.SERVICE; service: string }
  | { kind: typeof PrincipalKind.PLATFORM; operator: string };

/** The organization a principal acts within, when it has one. */
export type PrincipalOrganizationId = string | null;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * A single extracted fact. Provenance decides whether it may be used to grant:
 * a workflow-derived fact can only ever tighten a decision, because it can be
 * influenced by whoever controls the upstream data that produced it.
 */
export type Fact<T> =
  | { state: typeof FactState.KNOWN; value: T; provenance: FactProvenance }
  | { state: typeof FactState.ABSENT }
  | { state: typeof FactState.UNKNOWN; reason?: string };

export type AssetFact = {
  address?: string;
  symbol?: string;
  decimals?: number;
  /** Raw on-chain amount, as a decimal string to survive bigint precision. */
  amount?: string;
  /** Converted at decision time from an authoritative price source. */
  usdValue?: string;
  isStablecoin?: boolean;
};

export type CounterpartyRole = "recipient" | "spender" | "owner";

export type CounterpartyFact = {
  address: string;
  role: CounterpartyRole;
  /** Set when the address resolves to an address book entry. */
  label?: string;
};

/**
 * The structured view of a request that a decision is made from. Every field is
 * three-valued so "could not determine" is distinguishable from "does not
 * apply", which is what makes the fail-closed rule precise rather than
 * approximate.
 */
export type PolicyFacts = {
  capability: Capability;
  /** Canonical resource identifier, built by ./arn. */
  resource: Fact<string>;
  chainId: Fact<number>;
  contractAddress: Fact<string>;
  selector: Fact<string>;
  protocolSlug: Fact<string>;
  assets: Fact<readonly AssetFact[]>;
  counterparties: Fact<readonly CounterpartyFact[]>;
  nativeValueWei: Fact<string>;
  usdValue: Fact<string>;
  unbounded: Fact<boolean>;
  /** Gas ceiling the node declares, where it declares one. */
  gasPriceGwei: Fact<string>;
  gasLimit: Fact<string>;
  signerMode: Fact<string>;
  triggerType: Fact<string>;
  workflowId: Fact<string>;
  workflowTags: Fact<readonly string[]>;
  /** The project a control-plane action targets, where one applies. */
  projectId: Fact<string>;
  /** The IP the request came from, where the entry point knows it. */
  sourceIp: Fact<string>;
  /** The host, full URL and method of an outbound HTTP call. */
  httpHost: Fact<string>;
  httpUrl: Fact<string>;
  httpMethod: Fact<string>;
  /** Control-plane target, e.g. the workflow being updated. */
  resourceId: Fact<string>;
};

/**
 * A probabilistic input. Never sufficient to grant: signal-backed conditions are
 * rejected inside `allow` statements when a policy is compiled.
 */
export type PolicySignal =
  | {
      available: true;
      value: number | boolean;
      confidence: number;
      computedAt: number;
    }
  | { available: false };

export type PolicySignalBundle = Partial<Record<PolicySignalKey, PolicySignal>>;

// ---------------------------------------------------------------------------
// Policy document
// ---------------------------------------------------------------------------

export type PolicyConditionOperand =
  | string
  | number
  | boolean
  | readonly string[];

export type PolicyCondition = Partial<
  Record<PolicyOperator, PolicyConditionOperand>
>;

/** Condition keys are the known vocabulary or a `signal.` prefixed key. */
/**
 * Reserved keys that group conditions instead of naming a fact.
 *
 * Conditions in a map are combined with AND, which covers most rules and keeps
 * a statement readable. These are for the rest: a genuine either-or that would
 * otherwise have to be split into two statements that then drift apart.
 */
export const CONDITION_GROUP = {
  /** Matches when any branch matches. */
  ANY_OF: "anyOf",
  /** Matches when every branch matches. Useful only to nest inside anyOf. */
  ALL_OF: "allOf",
} as const;

export type ConditionGroupKey =
  (typeof CONDITION_GROUP)[keyof typeof CONDITION_GROUP];

export type PolicyConditionMap = Partial<
  Record<PolicyConditionKey | PolicySignalKey, PolicyCondition>
> & {
  readonly anyOf?: readonly PolicyConditionMap[];
  readonly allOf?: readonly PolicyConditionMap[];
};

export type PolicyLimit = {
  metric: PolicyLimitMetric;
  window: PolicyLimitWindow;
  /** Decimal string for USD and token amounts, integer for count. */
  max: string;
  scope: PolicyLimitScope;
  /**
   * The asset a token-denominated limit counts. Required for the `token`
   * metric and meaningless for the others, which is enforced at compile time.
   */
  asset?: string;
};

export type PolicyPostcondition = Partial<
  Record<PolicyPostconditionKey, PolicyCondition>
>;

export type PolicyStatement = {
  /** Stable identifier, referenced by decisions so a verdict is explainable. */
  sid: string;
  effect: PolicyEffect;
  /** Capability patterns. See capabilityMatches in ./capabilities. */
  capability: readonly string[];
  /** Resource identifier patterns. See arnMatches in ./arn. */
  resource?: readonly string[];
  counterparty?: readonly string[];
  condition?: PolicyConditionMap;
  limit?: readonly PolicyLimit[];
  postcondition?: PolicyPostcondition;
};

export type PolicyDocument = {
  schemaVersion: string;
  name: string;
  description?: string;
  enforcement: PolicyEnforcementMode;
  /**
   * What this policy claims authority over. Anything no policy claims is
   * unmanaged and passes through untouched; inside a claimed scope the default
   * is deny and the author grants back with allow statements.
   */
  manages: readonly string[];
  statements: readonly PolicyStatement[];
  postconditions?: PolicyPostcondition;
  /**
   * Confirms that a statement granting authority over the policy system itself
   * is intended.
   *
   * Rules about API keys, members, the address book or policy govern the
   * footing every other rule stands on, so the compiler refuses them until the
   * author says out loud that this is deliberate.
   */
  acknowledgeSelfReferential?: boolean;
};

export type OrganizationPolicy = {
  id: string;
  organizationId: string;
  enabled: boolean;
  version: number;
  document: PolicyDocument;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Compiled form
// ---------------------------------------------------------------------------

/**
 * A statement with its patterns parsed and its ontology references expanded.
 * Compilation is where the two soundness invariants are enforced, so an invalid
 * document fails when it is saved rather than when it fails to protect
 * something.
 */
export type CompiledStatement = {
  sid: string;
  policyId: string;
  effect: PolicyEffect;
  capabilities: readonly Capability[];
  resourcePatterns: readonly string[];
  counterpartyPatterns: readonly string[];
  condition: PolicyConditionMap;
  limits: readonly PolicyLimit[];
  postcondition: PolicyPostcondition;
};

export type CompiledPolicy = {
  policyId: string;
  name: string;
  enforcement: PolicyEnforcementMode;
  managedCapabilities: readonly Capability[];
  managedResourcePatterns: readonly string[];
  statements: readonly CompiledStatement[];
};

export type CompiledPolicySet = {
  organizationId: string;
  /** Pinned for the lifetime of a run so a mid-flight edit cannot split it. */
  version: string;
  policies: readonly CompiledPolicy[];
  compiledAt: number;
};

export type PolicyCompileError = {
  policyId?: string;
  sid?: string;
  message: string;
};

export type PolicyCompileResult =
  | { ok: true; compiled: CompiledPolicy }
  | { ok: false; errors: readonly PolicyCompileError[] };

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type PolicyRequest = {
  principal: Principal;
  organizationId: string;
  capability: Capability;
  facts: PolicyFacts;
  signals?: PolicySignalBundle;
  checkpoint: PolicyCheckpoint;
  /** Correlation identifiers, carried into the decision log. */
  executionId?: string;
  nodeId?: string;
  workflowId?: string;
};

export type MatchedStatement = {
  policyId: string;
  sid: string;
  effect: PolicyEffect;
};

/**
 * A reservation held against a limit. Settled when the action succeeds,
 * released when it fails, so concurrent actions cannot both squeeze under a cap.
 */
export type PolicyReservation = {
  reservationId: string;
  policyId: string;
  sid: string;
  metric: PolicyLimitMetric;
  amount: string;
};

export type PolicyDecision = {
  outcome: PolicyOutcome;
  reason: PolicyDecisionReason;
  /** Empty when unmanaged. */
  matched: readonly MatchedStatement[];
  /** Policies whose `manages` scope claimed this request. */
  governingPolicyIds: readonly string[];
  reservations: readonly PolicyReservation[];
  /** Content-addressed over the effective action; links the node and signing checks. */
  receiptId?: string;
  /** User-facing explanation. Redacted, never leaks policy internals. */
  message?: string;
  policyVersion: string | null;
  /** True when a governing policy is in monitor mode, so nothing was blocked. */
  observedOnly: boolean;
  evaluatedAt: number;
  durationMs: number;
};

/** Non-blocking evaluation result used by advisory checkpoints. */
export type PolicyEvaluation = {
  decision: PolicyDecision;
  wouldBlock: boolean;
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** What a guard returns when it permits an action to proceed. */
export type PolicyGuardAllowed = {
  blocked: false;
  decision: PolicyDecision;
};

export type PolicyGuardBlocked = {
  blocked: true;
  decision: PolicyDecision;
};

export type PolicyGuardResult = PolicyGuardAllowed | PolicyGuardBlocked;
