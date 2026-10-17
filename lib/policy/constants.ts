/**
 * Single source of truth for every policy-engine enum value.
 *
 * Every value is a `const` object plus a derived union type, mirroring the
 * `ExecutionErrorType` / `ErrorCategory` idiom used elsewhere in the codebase.
 * Call sites reference `PolicyEffect.DENY`, never the literal "deny", so a
 * renamed value is a compile error rather than a silent mismatch.
 *
 * Dependency-free on purpose: safe to import from client components, `"use step"`
 * plugin files, edge middleware, and the standalone executor process alike.
 */

/**
 * What a statement does when it matches.
 *
 * Allow and deny only. An approval effect was here, and it is gone: a workflow
 * node cannot wait for a person, so it behaved as a deny carrying a message
 * that promised an approver who did not exist. An effect that silently means
 * something other than what it says is worse than not offering it, so it comes
 * back when a run can genuinely be held, not before.
 */
export const PolicyEffect = {
  ALLOW: "allow",
  DENY: "deny",
} as const;

export type PolicyEffect = (typeof PolicyEffect)[keyof typeof PolicyEffect];

/**
 * The outcome of evaluating a request against the org's policy set. Wider than
 * PolicyEffect because "no policy claimed this request" is a distinct outcome
 * from "a statement allowed it", and the two must be distinguishable in the
 * decision log.
 */
export const PolicyOutcome = {
  /** A matching allow statement permitted it. */
  ALLOW: "allow",
  /** No policy declared authority over this request. Recorded, not enforced. */
  UNMANAGED: "unmanaged",
  /** A matching deny statement refused it, or nothing permitted it in scope. */
  DENY: "deny",
} as const;

export type PolicyOutcome = (typeof PolicyOutcome)[keyof typeof PolicyOutcome];

/**
 * Why the engine reached its outcome. Stored on every decision so the log is
 * explainable without re-running evaluation, and so the UI can render a cause
 * rather than a bare verdict.
 */
export const PolicyDecisionReason = {
  /** No policy's `manages` scope matched the request. */
  UNMANAGED: "unmanaged",
  /** An explicit deny statement matched. Deny overrides every other effect. */
  EXPLICIT_DENY: "explicit_deny",
  /** An explicit allow statement matched and its limits were reserved. */
  EXPLICIT_ALLOW: "explicit_allow",
  /** In scope, but no statement permitted it. The allowlist default. */
  NO_MATCHING_ALLOW: "no_matching_allow",
  /** A limit attached to the matching allow had no headroom left. */
  LIMIT_EXCEEDED: "limit_exceeded",
  /** A fact a governing policy needs could not be determined. */
  FACT_UNRESOLVED: "fact_unresolved",
  /**
   * The subject was never given this resource, as opposed to holding it and
   * being refused. The two need different answers: one is a missing grant,
   * usually on a workflow nobody has issued one to, and the other is a rule
   * doing its job. Reporting both as one makes the first look like the second.
   */
  NOT_GRANTED: "not_granted",
  /** The request carried no organization, so no policy set could be loaded. */
  NO_PRINCIPAL: "no_principal",
  /** The policy store was unreachable beyond the stale-serve window. */
  STORE_UNAVAILABLE: "store_unavailable",
  /** The engine itself threw. Never allow on an internal error. */
  ENGINE_ERROR: "engine_error",
} as const;

export type PolicyDecisionReason =
  (typeof PolicyDecisionReason)[keyof typeof PolicyDecisionReason];

/**
 * Reasons that represent the engine failing rather than a policy refusing.
 * They still deny, but they are operationally distinct: a spike in these is an
 * incident, a spike in EXPLICIT_DENY is a customer tightening their rules.
 */
export const ENGINE_FAILURE_REASONS: readonly PolicyDecisionReason[] = [
  PolicyDecisionReason.NO_PRINCIPAL,
  PolicyDecisionReason.STORE_UNAVAILABLE,
  PolicyDecisionReason.ENGINE_ERROR,
] as const;

export function isEngineFailureReason(reason: PolicyDecisionReason): boolean {
  return ENGINE_FAILURE_REASONS.includes(reason);
}

/**
 * Where a fact came from, which decides whether it may be used to grant.
 *
 * A WORKFLOW_DERIVED fact is one the workflow itself produced: an upstream
 * node's output, a resolved template, a webhook body, a trigger payload. It can
 * be influenced by whoever controls that upstream data, so it may only ever
 * tighten a decision. Enforced at policy-compile time, not at evaluation.
 */
export const FactProvenance = {
  /** Chain state, a price oracle, the ontology, or the org's own configuration. */
  AUTHORITATIVE: "authoritative",
  /** Produced by the workflow under evaluation. Never sufficient to allow. */
  WORKFLOW_DERIVED: "workflow_derived",
} as const;

export type FactProvenance =
  (typeof FactProvenance)[keyof typeof FactProvenance];

/**
 * Three-valued fact state. ABSENT and UNKNOWN are deliberately distinct: a
 * transfer has no spender (absent), while a transfer whose recipient is still an
 * unresolved template has an unknown one. Both are treated as most-restrictive,
 * but only UNKNOWN indicates the engine could not determine something it should
 * have been able to.
 */
export const FactState = {
  KNOWN: "known",
  ABSENT: "absent",
  UNKNOWN: "unknown",
} as const;

export type FactState = (typeof FactState)[keyof typeof FactState];

/** Which half of the system a capability belongs to. */
export const PolicyPlane = {
  /** What a running workflow does onchain. */
  DATA: "data",
  /** What members and agents may change about the organization. */
  CONTROL: "control",
} as const;

export type PolicyPlane = (typeof PolicyPlane)[keyof typeof PolicyPlane];

/**
 * Who is acting. Every decision needs a subject, and today the answer is spread
 * across five different mechanisms; this is the single vocabulary they collapse
 * into.
 */
export const PrincipalKind = {
  /** A signed-in organization member. */
  MEMBER: "member",
  /** An organization-scoped API key. */
  API_KEY: "api_key",
  /** An MCP OAuth token. The principal an agent typically uses. */
  OAUTH: "oauth",
  /** Internal service-to-service call, HMAC authenticated. */
  SERVICE: "service",
  /** Platform operator. Outside org policy by construction. */
  PLATFORM: "platform",
} as const;

export type PrincipalKind = (typeof PrincipalKind)[keyof typeof PrincipalKind];

/**
 * Principal kinds that carry an organization role and are therefore subject to
 * org policy. SERVICE and PLATFORM are not: they are the platform acting on its
 * own behalf and are governed by deployment controls, not by customer policy.
 */
export const ORG_SCOPED_PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  PrincipalKind.MEMBER,
  PrincipalKind.API_KEY,
  PrincipalKind.OAUTH,
] as const;

export function isOrgScopedPrincipalKind(kind: PrincipalKind): boolean {
  return ORG_SCOPED_PRINCIPAL_KINDS.includes(kind);
}

/** Organization roles, ordered. Mirrors the Better Auth role vocabulary. */
export const PolicyRole = {
  MEMBER: "member",
  ADMIN: "admin",
  OWNER: "owner",
} as const;

export type PolicyRole = (typeof PolicyRole)[keyof typeof PolicyRole];

/**
 * Rank for floor comparisons. An unrecognised role yields undefined and is
 * denied, which is the intended fail-closed behaviour for a plain text column.
 */
export const POLICY_ROLE_RANK: Readonly<Record<PolicyRole, number>> = {
  [PolicyRole.MEMBER]: 1,
  [PolicyRole.ADMIN]: 2,
  [PolicyRole.OWNER]: 3,
} as const;

/**
 * Whether a policy blocks or only observes. Monitor mode evaluates and records
 * exactly as enforce mode does, and never changes the outcome of a request.
 */
export const PolicyEnforcementMode = {
  MONITOR: "monitor",
  ENFORCE: "enforce",
} as const;

export type PolicyEnforcementMode =
  (typeof PolicyEnforcementMode)[keyof typeof PolicyEnforcementMode];

/** Where in the request lifecycle a decision was made. */
export const PolicyCheckpoint = {
  /** Authoring time. Advisory only, never blocks a run. */
  AUTHORING: "authoring",
  /** At the node, after its values resolve. The authoritative decision. */
  NODE: "node",
  /** Before bytes are signed. Backstop for paths that skip the node check. */
  SIGNING: "signing",
  /** A mutating API call. The control-plane checkpoint. */
  CONTROL_PLANE: "control_plane",
} as const;

export type PolicyCheckpoint =
  (typeof PolicyCheckpoint)[keyof typeof PolicyCheckpoint];

/** Lifecycle of a reserved budget amount. Mirrors the org value ledger. */
export const PolicyReservationStatus = {
  RESERVED: "reserved",
  SETTLED: "settled",
  RELEASED: "released",
} as const;

export type PolicyReservationStatus =
  (typeof PolicyReservationStatus)[keyof typeof PolicyReservationStatus];

/** What a limit counts. */
export const PolicyLimitMetric = {
  /** Cumulative USD value, so a limit spans assets and chains. */
  USD: "usd",
  /**
   * Cumulative amount of one named asset, in that asset's own units.
   *
   * Denominating in the token rather than in dollars removes the oracle from
   * the decision, which matters when the point of the rule is "at most 100k
   * USDC" rather than "at most $100k of whatever this is worth today".
   */
  TOKEN: "token",
  /** Number of matching actions, which catches a thrashing agent. */
  COUNT: "count",
} as const;

export type PolicyLimitMetric =
  (typeof PolicyLimitMetric)[keyof typeof PolicyLimitMetric];

/**
 * Limit windows. Discrete rather than rolling, matching how onchain allowance
 * refills work, so a limit stays expressible if it is ever compiled to a
 * backend that only supports discrete periods.
 */
export const PolicyLimitWindow = {
  HOUR: "1h",
  DAY: "1d",
  WEEK: "7d",
  MONTH: "30d",
} as const;

export type PolicyLimitWindow =
  (typeof PolicyLimitWindow)[keyof typeof PolicyLimitWindow];

export const POLICY_LIMIT_WINDOW_SECONDS: Readonly<
  Record<PolicyLimitWindow, number>
> = {
  [PolicyLimitWindow.HOUR]: 3600,
  [PolicyLimitWindow.DAY]: 86_400,
  [PolicyLimitWindow.WEEK]: 604_800,
  [PolicyLimitWindow.MONTH]: 2_592_000,
} as const;

/** What a limit is counted against. */
export const PolicyLimitScope = {
  ORGANIZATION: "organization",
  WORKFLOW: "workflow",
  PRINCIPAL: "principal",
} as const;

export type PolicyLimitScope =
  (typeof PolicyLimitScope)[keyof typeof PolicyLimitScope];

/**
 * Condition keys the engine understands. Anything not listed is rejected at
 * compile time rather than silently evaluating to false, so a typo in a policy
 * document is caught when it is saved rather than when it fails to protect
 * something.
 */
export const PolicyConditionKey = {
  USD_VALUE: "usdValue",
  AMOUNT: "amount",
  /** True for approve(max) and setApprovalForAll(true). */
  UNBOUNDED: "unbounded",
  ASSET: "asset",
  COUNTERPARTY: "counterparty",
  SPENDER: "spender",
  RECIPIENT: "recipient",
  CHAIN_ID: "chainId",
  SELECTOR: "selector",
  GAS_PRICE_GWEI: "gasPriceGwei",
  GAS_LIMIT: "gasLimit",
  /** Which trigger started the run: manual, schedule, webhook, event. */
  TRIGGER_TYPE: "triggerType",
  /** Principal kind, so "MCP direct execution is capped" is expressible. */
  ACTOR: "actor",
  /**
   * The acting principal's organization role: owner, admin or member.
   *
   * What "who may create an API key" is actually written against. Derived from
   * the principal at evaluation time rather than supplied by a caller, so it
   * cannot be forgotten or spoofed by one.
   */
  ACTOR_ROLE: "actorRole",
  /** The acting principal's identifier, to name one person or one key. */
  ACTOR_ID: "actorId",
  AUTH_METHOD: "authMethod",
  /** Which wallet mode signs: eoa, safe, safe-role. */
  SIGNER_MODE: "signerMode",
  TIME_WINDOW: "timeWindow",
  DAY_OF_WEEK: "dayOfWeek",
  WORKFLOW_ID: "workflowId",
  WORKFLOW_TAG: "workflowTag",
  /**
   * The project a workflow lives in.
   *
   * The scope that makes a rule about creation expressible: a workflow being
   * created has no id yet, so "who may create a workflow" can only be narrowed
   * by where it is being created.
   */
  PROJECT_ID: "projectId",
  RESOURCE_ID: "resourceId",
  /**
   * The IP the request came from.
   *
   * Ambient, so it constrains every action rather than one kind: "nothing from
   * outside the office network" is one rule, not one per capability.
   */
  SOURCE_IP: "sourceIp",
  /** The host an outbound HTTP call targets. */
  HTTP_HOST: "httpHost",
  /** The full URL an outbound HTTP call targets. */
  HTTP_URL: "httpUrl",
  /** The HTTP method an outbound call uses. */
  HTTP_METHOD: "httpMethod",
} as const;

export type PolicyConditionKey =
  (typeof PolicyConditionKey)[keyof typeof PolicyConditionKey];

/**
 * Prefix marking a condition key as a probabilistic signal.
 *
 * Signal-backed conditions may appear only in `deny`
 * statements. The compiler rejects a document that references one inside an
 * `allow`, which makes "a guess may tighten a decision but never grant one" a
 * property of the document rather than a convention.
 */
export const SIGNAL_CONDITION_PREFIX = "signal." as const;

export const PolicySignalKey = {
  /** Target is not in the ontology, unverified, or recently deployed. */
  CONTRACT_UNKNOWN: "signal.contractUnknown",
  RISK_SCORE: "signal.riskScore",
  ASSET_DEPEGGED: "signal.assetDepegged",
  PROMPT_INJECTION: "signal.promptInjection",
  SPEND_ANOMALY: "signal.spendAnomaly",
} as const;

export type PolicySignalKey =
  (typeof PolicySignalKey)[keyof typeof PolicySignalKey];

export function isSignalConditionKey(key: string): boolean {
  return key.startsWith(SIGNAL_CONDITION_PREFIX);
}

/** Comparison operators available inside a condition. */
export const PolicyOperator = {
  EQ: "eq",
  NEQ: "neq",
  LT: "lt",
  LTE: "lte",
  GT: "gt",
  GTE: "gte",
  IN: "in",
  NOT_IN: "notIn",
  MATCHES: "matches",
  /** IP membership of a CIDR range, e.g. "10.0.0.0/8". */
  IN_CIDR: "inCidr",
  NOT_IN_CIDR: "notInCidr",
  /** Host membership of a domain list, where "*.example.com" covers any subdomain. */
  IN_DOMAIN: "inDomain",
  NOT_IN_DOMAIN: "notInDomain",
} as const;

export type PolicyOperator =
  (typeof PolicyOperator)[keyof typeof PolicyOperator];

/** Assertions checked after an action returns, not before it runs. */
export const PolicyPostconditionKey = {
  /** An approval granted for a step must be back to zero afterwards. */
  RESIDUAL_APPROVAL: "residualApproval",
  /** The value that moved must be the value that was authorized. */
  VALUE_DELTA: "valueDelta",
  RECIPIENT_RECEIVED: "recipientReceived",
  ASSET_MOVED: "assetMoved",
} as const;

export type PolicyPostconditionKey =
  (typeof PolicyPostconditionKey)[keyof typeof PolicyPostconditionKey];

/**
 * How long a compiled policy set may be served from cache, and how long a
 * last-known-good set may be served after the store starts failing. Past the
 * stale window the engine denies with STORE_UNAVAILABLE rather than guessing.
 */
export const POLICY_CACHE_TTL_MS =
  process.env.CI || process.env.NODE_ENV === "test" ? 0 : 30_000;

export const POLICY_STALE_SERVE_MAX_MS = 300_000;

/**
 * How long a decision receipt stays consumable by the signing-time check.
 * Matches the stale-inflight window used by the value ledger so a crashed pod
 * cannot leave a reusable receipt behind.
 */
export const POLICY_RECEIPT_TTL_MS = 900_000;

/** Current policy document schema version. */
/**
 * The name a policy carries until it is given one.
 *
 * "Draft" rather than "Untitled" because it says something true about the
 * policy's state: a new policy starts in monitor mode, recording what it would
 * have done without blocking anything, and stays a draft until enforcement is
 * turned on.
 */
export const DEFAULT_POLICY_NAME = "Draft policy" as const;

export const POLICY_SCHEMA_VERSION = "2026-08" as const;
