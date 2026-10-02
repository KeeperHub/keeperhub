/**
 * The capability vocabulary: what a request is trying to do.
 *
 * Capabilities form a tree. A policy written against a parent covers every
 * descendant, so "deny all lending" keeps working when a new lending protocol
 * is added. Leaves map one-to-one from the action types workflows already use,
 * via a prebuilt reverse index rather than a scan.
 *
 * Adding a capability is a one-entry diff in CAPABILITIES. The parent chain is
 * derived from the dotted path, so the tree never needs to be declared twice.
 */

import { ARN_WILDCARD_DEEP, ARN_WILDCARD_SEGMENT } from "./arn";
import { PolicyPlane } from "./constants";

/** Capability paths are dotted, unlike resource identifiers which are slashed. */
export const CAPABILITY_SEPARATOR = "." as const;

export const CAPABILITY_WILDCARD_SUFFIX =
  `${CAPABILITY_SEPARATOR}${ARN_WILDCARD_SEGMENT}` as const;

export const CAPABILITY_WILDCARD_DEEP_SUFFIX =
  `${CAPABILITY_SEPARATOR}${ARN_WILDCARD_DEEP}` as const;

/**
 * Every capability the engine understands, keyed by its dotted path.
 *
 * Data-plane leaves describe onchain effects. Control-plane leaves reuse the
 * resource and action names from the Better Auth permission statement so the
 * two systems share one vocabulary rather than competing.
 */
export const Capability = {
  // Data plane: value movement
  ASSET_TRANSFER_NATIVE: "asset.transfer.native",
  ASSET_TRANSFER_TOKEN: "asset.transfer.token",
  ASSET_APPROVE: "asset.approve",
  /** An offchain signature that authorizes value movement: permit, EIP-3009. */
  ASSET_PERMIT: "asset.permit",

  // Data plane: raw contract interaction
  CONTRACT_READ: "contract.read",
  CONTRACT_WRITE: "contract.write",

  // Data plane: protocol semantics
  PROTOCOL_LENDING_SUPPLY: "protocol.lending.supply",
  PROTOCOL_LENDING_WITHDRAW: "protocol.lending.withdraw",
  PROTOCOL_LENDING_BORROW: "protocol.lending.borrow",
  PROTOCOL_LENDING_REPAY: "protocol.lending.repay",
  PROTOCOL_DEX_SWAP: "protocol.dex.swap",
  PROTOCOL_STAKING_STAKE: "protocol.staking.stake",
  PROTOCOL_STAKING_UNSTAKE: "protocol.staking.unstake",

  // Data plane: off-chain effects a workflow can have
  OFFCHAIN_HTTP: "offchain.http",
  OFFCHAIN_NOTIFY: "offchain.notify",
  DATA_QUERY: "data.query",

  // Control plane
  WORKFLOW_CREATE: "workflow.create",
  WORKFLOW_UPDATE: "workflow.update",
  WORKFLOW_DELETE: "workflow.delete",
  WORKFLOW_PUBLISH: "workflow.publish",
  INTEGRATION_CREATE: "integration.create",
  INTEGRATION_UPDATE: "integration.update",
  INTEGRATION_DELETE: "integration.delete",
  WALLET_CREATE: "wallet.create",
  WALLET_UPDATE: "wallet.update",
  WALLET_DELETE: "wallet.delete",
  /**
   * Widening a Safe's onchain permission scope is its own capability.
   *
   * Safe-specific: the managed signer has no role modifier to widen.
   */
  WALLET_ROLE_UPDATE: "wallet.role.update",
  ADDRESSBOOK_CREATE: "addressbook.create",
  ADDRESSBOOK_UPDATE: "addressbook.update",
  ADDRESSBOOK_DELETE: "addressbook.delete",
  MEMBER_INVITE: "member.invite",
  MEMBER_UPDATE: "member.update",
  MEMBER_REMOVE: "member.remove",
  APIKEY_CREATE: "apikey.create",
  APIKEY_DELETE: "apikey.delete",
  /** Editing policy itself. The meta case, and the most sensitive. */
  POLICY_UPDATE: "policy.update",
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

export type CapabilityDefinition = {
  id: Capability;
  plane: PolicyPlane;
  label: string;
  /** True when exercising this can move value or grant someone else the ability to. */
  valueMoving: boolean;
  /**
   * True when the guard dimensions for this capability can be enumerated, which
   * is what makes a coverage score computable rather than decorative.
   */
  guardDimensions: readonly string[];
};

/** Guard dimensions, shared so the coverage score and the editor agree. */
export const GuardDimension = {
  ASSET: "asset",
  COUNTERPARTY: "counterparty",
  AMOUNT: "amount",
  CHAIN: "chain",
  CONTRACT: "contract",
  SELECTOR: "selector",
  TRIGGER: "trigger",
  ACTOR: "actor",
  TIMING: "timing",
  FREQUENCY: "frequency",
  GAS: "gas",
} as const;

export type GuardDimension =
  (typeof GuardDimension)[keyof typeof GuardDimension];

const VALUE_GUARDS: readonly GuardDimension[] = [
  GuardDimension.ASSET,
  GuardDimension.COUNTERPARTY,
  GuardDimension.AMOUNT,
  GuardDimension.CHAIN,
  GuardDimension.TRIGGER,
  GuardDimension.ACTOR,
  GuardDimension.TIMING,
  GuardDimension.FREQUENCY,
] as const;

const CONTRACT_GUARDS: readonly GuardDimension[] = [
  ...VALUE_GUARDS,
  GuardDimension.CONTRACT,
  GuardDimension.SELECTOR,
  GuardDimension.GAS,
] as const;

const CONTROL_GUARDS: readonly GuardDimension[] = [
  GuardDimension.ACTOR,
  GuardDimension.TIMING,
  GuardDimension.FREQUENCY,
] as const;

function dataLeaf(
  id: Capability,
  label: string,
  guards: readonly GuardDimension[],
  valueMoving: boolean
): CapabilityDefinition {
  return {
    id,
    plane: PolicyPlane.DATA,
    label,
    valueMoving,
    guardDimensions: guards,
  };
}

function controlLeaf(id: Capability, label: string): CapabilityDefinition {
  return {
    id,
    plane: PolicyPlane.CONTROL,
    label,
    valueMoving: false,
    guardDimensions: CONTROL_GUARDS,
  };
}

export const CAPABILITIES: Readonly<Record<Capability, CapabilityDefinition>> =
  {
    [Capability.ASSET_TRANSFER_NATIVE]: dataLeaf(
      Capability.ASSET_TRANSFER_NATIVE,
      "Transfer native currency",
      VALUE_GUARDS,
      true
    ),
    [Capability.ASSET_TRANSFER_TOKEN]: dataLeaf(
      Capability.ASSET_TRANSFER_TOKEN,
      "Transfer a token",
      VALUE_GUARDS,
      true
    ),
    [Capability.ASSET_APPROVE]: dataLeaf(
      Capability.ASSET_APPROVE,
      "Approve a spender",
      VALUE_GUARDS,
      true
    ),
    [Capability.ASSET_PERMIT]: dataLeaf(
      Capability.ASSET_PERMIT,
      "Sign a transfer authorization",
      VALUE_GUARDS,
      true
    ),
    [Capability.CONTRACT_READ]: dataLeaf(
      Capability.CONTRACT_READ,
      "Read from a contract",
      [GuardDimension.CHAIN, GuardDimension.CONTRACT],
      false
    ),
    [Capability.CONTRACT_WRITE]: dataLeaf(
      Capability.CONTRACT_WRITE,
      "Write to a contract",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.PROTOCOL_LENDING_SUPPLY]: dataLeaf(
      Capability.PROTOCOL_LENDING_SUPPLY,
      "Supply to a lending market",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.PROTOCOL_LENDING_WITHDRAW]: dataLeaf(
      Capability.PROTOCOL_LENDING_WITHDRAW,
      "Withdraw from a lending market",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.PROTOCOL_LENDING_BORROW]: dataLeaf(
      Capability.PROTOCOL_LENDING_BORROW,
      "Borrow from a lending market",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.PROTOCOL_LENDING_REPAY]: dataLeaf(
      Capability.PROTOCOL_LENDING_REPAY,
      "Repay a lending market",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.PROTOCOL_DEX_SWAP]: dataLeaf(
      Capability.PROTOCOL_DEX_SWAP,
      "Swap on a decentralized exchange",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.PROTOCOL_STAKING_STAKE]: dataLeaf(
      Capability.PROTOCOL_STAKING_STAKE,
      "Stake",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.PROTOCOL_STAKING_UNSTAKE]: dataLeaf(
      Capability.PROTOCOL_STAKING_UNSTAKE,
      "Unstake",
      CONTRACT_GUARDS,
      true
    ),
    [Capability.OFFCHAIN_HTTP]: dataLeaf(
      Capability.OFFCHAIN_HTTP,
      "Call an external endpoint",
      [GuardDimension.ACTOR, GuardDimension.TIMING, GuardDimension.FREQUENCY],
      false
    ),
    [Capability.OFFCHAIN_NOTIFY]: dataLeaf(
      Capability.OFFCHAIN_NOTIFY,
      "Send a notification",
      [GuardDimension.ACTOR, GuardDimension.TIMING, GuardDimension.FREQUENCY],
      false
    ),
    [Capability.DATA_QUERY]: dataLeaf(
      Capability.DATA_QUERY,
      "Query a database",
      [GuardDimension.ACTOR, GuardDimension.TIMING, GuardDimension.FREQUENCY],
      false
    ),
    [Capability.WORKFLOW_CREATE]: controlLeaf(
      Capability.WORKFLOW_CREATE,
      "Create a workflow"
    ),
    [Capability.WORKFLOW_UPDATE]: controlLeaf(
      Capability.WORKFLOW_UPDATE,
      "Update a workflow"
    ),
    [Capability.WORKFLOW_DELETE]: controlLeaf(
      Capability.WORKFLOW_DELETE,
      "Delete a workflow"
    ),
    [Capability.WORKFLOW_PUBLISH]: controlLeaf(
      Capability.WORKFLOW_PUBLISH,
      "Publish a workflow"
    ),
    [Capability.INTEGRATION_CREATE]: controlLeaf(
      Capability.INTEGRATION_CREATE,
      "Add a connection"
    ),
    [Capability.INTEGRATION_UPDATE]: controlLeaf(
      Capability.INTEGRATION_UPDATE,
      "Update a connection"
    ),
    [Capability.INTEGRATION_DELETE]: controlLeaf(
      Capability.INTEGRATION_DELETE,
      "Remove a connection"
    ),
    [Capability.WALLET_CREATE]: controlLeaf(
      Capability.WALLET_CREATE,
      "Deploy a Safe"
    ),
    [Capability.WALLET_UPDATE]: controlLeaf(
      Capability.WALLET_UPDATE,
      "Update a Safe"
    ),
    [Capability.WALLET_DELETE]: controlLeaf(
      Capability.WALLET_DELETE,
      "Remove a Safe"
    ),
    [Capability.WALLET_ROLE_UPDATE]: controlLeaf(
      Capability.WALLET_ROLE_UPDATE,
      "Change a Safe permission scope"
    ),
    [Capability.ADDRESSBOOK_CREATE]: controlLeaf(
      Capability.ADDRESSBOOK_CREATE,
      "Add an address book entry"
    ),
    [Capability.ADDRESSBOOK_UPDATE]: controlLeaf(
      Capability.ADDRESSBOOK_UPDATE,
      "Update an address book entry"
    ),
    [Capability.ADDRESSBOOK_DELETE]: controlLeaf(
      Capability.ADDRESSBOOK_DELETE,
      "Delete an address book entry"
    ),
    [Capability.MEMBER_INVITE]: controlLeaf(
      Capability.MEMBER_INVITE,
      "Invite a member"
    ),
    [Capability.MEMBER_UPDATE]: controlLeaf(
      Capability.MEMBER_UPDATE,
      "Change a member role"
    ),
    [Capability.MEMBER_REMOVE]: controlLeaf(
      Capability.MEMBER_REMOVE,
      "Remove a member"
    ),
    [Capability.APIKEY_CREATE]: controlLeaf(
      Capability.APIKEY_CREATE,
      "Create an API key"
    ),
    [Capability.APIKEY_DELETE]: controlLeaf(
      Capability.APIKEY_DELETE,
      "Delete an API key"
    ),
    [Capability.POLICY_UPDATE]: controlLeaf(
      Capability.POLICY_UPDATE,
      "Change organization policy"
    ),
  } as const;

const ALL_CAPABILITIES: readonly Capability[] = Object.keys(
  CAPABILITIES
) as Capability[];

export function getCapability(id: Capability): CapabilityDefinition {
  return CAPABILITIES[id];
}

export function isCapability(value: string): value is Capability {
  return value in CAPABILITIES;
}

export function getCapabilitiesByPlane(
  plane: PolicyPlane
): readonly Capability[] {
  return ALL_CAPABILITIES.filter((id) => CAPABILITIES[id].plane === plane);
}

/**
 * Ancestors of a capability, nearest first, derived from the dotted path.
 * `protocol.lending.borrow` yields `["protocol.lending", "protocol"]`.
 *
 * Ancestors are not themselves members of Capability: they are addressable in a
 * policy but never the identity of a concrete action.
 */
export function capabilityAncestors(id: Capability): readonly string[] {
  const parts = id.split(CAPABILITY_SEPARATOR);
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    out.push(parts.slice(0, i).join(CAPABILITY_SEPARATOR));
  }
  return out;
}

/**
 * Whether `pattern` covers `id`. A pattern is a capability, an ancestor path,
 * or either of those suffixed with a wildcard segment.
 *
 *   asset.transfer.**  covers asset.transfer.native
 *   asset.transfer.*   covers asset.transfer.native
 *   asset.transfer     covers asset.transfer.native
 *   asset.**           covers asset.transfer.native
 */
export function capabilityMatches(pattern: string, id: Capability): boolean {
  if (pattern === id) {
    return true;
  }
  if (pattern === ARN_WILDCARD_DEEP || pattern === ARN_WILDCARD_SEGMENT) {
    return true;
  }

  const deep = pattern.endsWith(CAPABILITY_WILDCARD_DEEP_SUFFIX);
  const shallow = pattern.endsWith(CAPABILITY_WILDCARD_SUFFIX);

  const trimmed = stripWildcardSuffix(pattern, deep, shallow);

  if (trimmed === id) {
    return true;
  }

  const prefix = `${trimmed}${CAPABILITY_SEPARATOR}`;
  if (!id.startsWith(prefix)) {
    return false;
  }

  // A single-segment wildcard matches exactly one level below the prefix; a
  // deep wildcard or a bare ancestor path matches any depth.
  if (shallow && !deep) {
    return !id.slice(prefix.length).includes(CAPABILITY_SEPARATOR);
  }

  return true;
}

function stripWildcardSuffix(
  pattern: string,
  deep: boolean,
  shallow: boolean
): string {
  if (deep) {
    return pattern.slice(0, -CAPABILITY_WILDCARD_DEEP_SUFFIX.length);
  }
  if (shallow) {
    return pattern.slice(0, -CAPABILITY_WILDCARD_SUFFIX.length);
  }
  return pattern;
}

/** Every capability a pattern covers. Used to expand a `manages` scope. */
export function expandCapabilityPattern(
  pattern: string
): readonly Capability[] {
  return ALL_CAPABILITIES.filter((id) => capabilityMatches(pattern, id));
}

/**
 * Whether a capability acts on a chain.
 *
 * Read from the guard dimensions rather than from a hand-kept list, so it
 * cannot drift: a capability that can be constrained by chain or contract is
 * onchain, and one that cannot is not. Querying a database and calling an
 * external endpoint sit in the data plane because they are things a workflow
 * does, but neither touches a chain, and presenting them as onchain would offer
 * a chain picker for a rule that can never bind one.
 */
export function isOnchainCapability(capability: Capability): boolean {
  const guards = CAPABILITIES[capability]?.guardDimensions ?? [];
  return (
    guards.includes(GuardDimension.CHAIN) ||
    guards.includes(GuardDimension.CONTRACT)
  );
}
