import { PolicyConditionKey } from "@/lib/policy/constants";

/**
 * Risk classes group selectors by what they can do to an organization, which
 * is what makes an over-broad policy legible: "Limited: position management,
 * Full: access control" reads as a red flag without reading any selector.
 */
export const PolicyRiskClass = {
  READ: "read",
  VALUE_TRANSFER: "value-transfer",
  POSITION_MANAGEMENT: "position-management",
  APPROVAL: "approval",
  ACCESS_CONTROL: "access-control",
  EMERGENCY: "emergency",
  /** Write of unrecognised shape. Claims nothing rather than guessing. */
  UNKNOWN: "unknown",
} as const;

export type PolicyRiskClass =
  (typeof PolicyRiskClass)[keyof typeof PolicyRiskClass];

export const RISK_CLASS_LABEL: Record<PolicyRiskClass, string> = {
  [PolicyRiskClass.READ]: "Read",
  [PolicyRiskClass.VALUE_TRANSFER]: "Value transfer",
  [PolicyRiskClass.POSITION_MANAGEMENT]: "Position management",
  [PolicyRiskClass.APPROVAL]: "Approval",
  [PolicyRiskClass.ACCESS_CONTROL]: "Access control",
  [PolicyRiskClass.EMERGENCY]: "Emergency",
  [PolicyRiskClass.UNKNOWN]: "Unrecognised",
};

/** Ordered most to least dangerous, for grouping in the picker. */
export const RISK_CLASS_ORDER: readonly PolicyRiskClass[] = [
  PolicyRiskClass.ACCESS_CONTROL,
  PolicyRiskClass.EMERGENCY,
  PolicyRiskClass.APPROVAL,
  PolicyRiskClass.VALUE_TRANSFER,
  PolicyRiskClass.POSITION_MANAGEMENT,
  PolicyRiskClass.UNKNOWN,
  PolicyRiskClass.READ,
];

/** The role a parameter plays, where the derivation can identify one. */
export const SelectorParameterRole = {
  RECIPIENT: "recipient",
  SPENDER: "spender",
  ASSET: "asset",
  AMOUNT: "amount",
} as const;

export type SelectorParameterRole =
  (typeof SelectorParameterRole)[keyof typeof SelectorParameterRole];

/**
 * Condition keys that describe the request rather than the call, so they are
 * meaningful for every selector and are not part of a catalog entry.
 */
export const AMBIENT_CONDITION_KEYS: readonly PolicyConditionKey[] = [
  PolicyConditionKey.CHAIN_ID,
  PolicyConditionKey.SELECTOR,
  PolicyConditionKey.TRIGGER_TYPE,
  PolicyConditionKey.ACTOR,
  PolicyConditionKey.AUTH_METHOD,
  PolicyConditionKey.SIGNER_MODE,
  PolicyConditionKey.TIME_WINDOW,
  PolicyConditionKey.DAY_OF_WEEK,
  PolicyConditionKey.WORKFLOW_ID,
  PolicyConditionKey.WORKFLOW_TAG,
];

/**
 * Selector-dependent condition keys per risk class, before narrowing against
 * the parameters a given function actually has.
 */
export const RISK_CLASS_CONDITION_KEYS: Record<
  PolicyRiskClass,
  readonly PolicyConditionKey[]
> = {
  [PolicyRiskClass.READ]: [],
  [PolicyRiskClass.VALUE_TRANSFER]: [
    PolicyConditionKey.USD_VALUE,
    PolicyConditionKey.AMOUNT,
    PolicyConditionKey.ASSET,
    PolicyConditionKey.RECIPIENT,
    PolicyConditionKey.COUNTERPARTY,
  ],
  [PolicyRiskClass.POSITION_MANAGEMENT]: [
    PolicyConditionKey.USD_VALUE,
    PolicyConditionKey.AMOUNT,
    PolicyConditionKey.ASSET,
    PolicyConditionKey.COUNTERPARTY,
  ],
  [PolicyRiskClass.APPROVAL]: [
    PolicyConditionKey.UNBOUNDED,
    PolicyConditionKey.SPENDER,
    PolicyConditionKey.ASSET,
    PolicyConditionKey.AMOUNT,
  ],
  [PolicyRiskClass.ACCESS_CONTROL]: [],
  [PolicyRiskClass.EMERGENCY]: [],
  [PolicyRiskClass.UNKNOWN]: [],
};

/** Risk classes where a spend or count limit can bind. */
export const LIMIT_BEARING_RISK_CLASSES: readonly PolicyRiskClass[] = [
  PolicyRiskClass.VALUE_TRANSFER,
  PolicyRiskClass.POSITION_MANAGEMENT,
  PolicyRiskClass.APPROVAL,
];

/**
 * Bumped whenever the derivation rules change.
 *
 * A persisted catalog row built by older rules is stale even though its ABI is
 * unchanged, so the version is stored alongside each row and a mismatch forces
 * a rebuild from the cached ABI rather than serving a classification the
 * current rules would not produce.
 */
export const CATALOG_SCHEMA_VERSION = "2026-08" as const;

/**
 * The capability a risk class implies, used to fill a statement's `capability`
 * from a function selection.
 *
 * Deliberately coarse: a rule authored from the function picker names the
 * capability that governs the shape of the call, and the resource pins exactly
 * which function it is. Access control and emergency calls have no protocol
 * semantics, so they fall to the raw contract-write capability, which is
 * accurate rather than flattering.
 */
export const RISK_CLASS_CAPABILITIES: Record<
  PolicyRiskClass,
  readonly string[]
> = {
  [PolicyRiskClass.READ]: ["contract.read"],
  [PolicyRiskClass.VALUE_TRANSFER]: [
    "asset.transfer.native",
    "asset.transfer.token",
  ],
  [PolicyRiskClass.POSITION_MANAGEMENT]: ["contract.write"],
  [PolicyRiskClass.APPROVAL]: ["asset.approve"],
  [PolicyRiskClass.ACCESS_CONTROL]: ["contract.write"],
  [PolicyRiskClass.EMERGENCY]: ["contract.write"],
  [PolicyRiskClass.UNKNOWN]: ["contract.write"],
};
