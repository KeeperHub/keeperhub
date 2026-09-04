import {
  CAPABILITIES,
  type Capability,
  getCapabilitiesByPlane,
  isOnchainCapability,
} from "@/lib/policy/capabilities";
import {
  CONTROL_TARGETS,
  capabilitiesForTarget,
  STATEMENT_TARGET_HINT,
  STATEMENT_TARGET_LABEL,
  StatementTarget,
  TARGET_RESOURCE_LIST,
} from "@/lib/policy/catalog/control-plane";
import { PolicyEffect, PolicyPlane, PolicyRole } from "@/lib/policy/constants";
import type {
  CatalogMember,
  CatalogToken,
  PolicyCatalog,
  PolicyOption,
} from "@/lib/policy/ui/types";

/**
 * Every list the policy UI offers, built here and nowhere else.
 *
 * Two components building "the members list" from the same catalog is how they
 * come to disagree: one gains a group heading, the other keeps showing raw ids,
 * and a fix lands in one of them. These are plain functions over catalog data,
 * so they are equally usable from a hook, a component or a test.
 */

const ADDRESS_HEAD = 6;
const ADDRESS_TAIL = 4;

/** Shortens an address for display, keeping both ends that people read. */
export function shortAddress(address: string): string {
  return `${address.slice(0, ADDRESS_HEAD)}...${address.slice(-ADDRESS_TAIL)}`;
}

export const EFFECT_LABEL: Record<PolicyEffect, string> = {
  [PolicyEffect.ALLOW]: "Allow",
  [PolicyEffect.DENY]: "Deny",
};

export const EFFECT_OPTIONS: PolicyOption[] = Object.values(PolicyEffect).map(
  (effect) => ({ value: effect, label: EFFECT_LABEL[effect] })
);

export const ROLE_LABEL: Record<string, string> = {
  [PolicyRole.OWNER]: "Owner",
  [PolicyRole.ADMIN]: "Admins",
  [PolicyRole.MEMBER]: "Members",
};

export const POLICY_ROLES: readonly string[] = [
  PolicyRole.OWNER,
  PolicyRole.ADMIN,
  PolicyRole.MEMBER,
];

/** What a rule can govern: an onchain call, an offchain action, or a resource. */
export const TARGET_OPTIONS: PolicyOption[] = [
  StatementTarget.ONCHAIN,
  StatementTarget.OFFCHAIN,
  ...CONTROL_TARGETS,
].map((target) => ({
  value: target,
  label: STATEMENT_TARGET_LABEL[target],
  hint: STATEMENT_TARGET_HINT[target],
}));

const DATA_CAPABILITIES = getCapabilitiesByPlane(PolicyPlane.DATA);

export const ONCHAIN_CAPABILITIES: readonly Capability[] =
  DATA_CAPABILITIES.filter((capability) => isOnchainCapability(capability));

/**
 * Data-plane actions that touch no chain: an HTTP call, a notification, a
 * database query. Grouped apart so neither the builder nor the simulator offers
 * a chain picker for a rule that can never bind one.
 */
export const OFFCHAIN_CAPABILITIES: readonly Capability[] =
  DATA_CAPABILITIES.filter((capability) => !isOnchainCapability(capability));

/** Every action, grouped by what it acts on. */
export const ACTION_OPTIONS: PolicyOption[] = [
  ...ONCHAIN_CAPABILITIES.map((id) => ({
    value: id,
    label: CAPABILITIES[id].label,
    group: "Onchain",
  })),
  ...OFFCHAIN_CAPABILITIES.map((id) => ({
    value: id,
    label: CAPABILITIES[id].label,
    group: "Offchain",
  })),
  ...CONTROL_TARGETS.flatMap((target) =>
    capabilitiesForTarget(target).map((id) => ({
      value: id,
      label: CAPABILITIES[id].label,
      group: STATEMENT_TARGET_LABEL[target],
    }))
  ),
];

export function memberOptions(
  members: readonly CatalogMember[]
): PolicyOption[] {
  return members.map((entry) => ({
    value: entry.id,
    label: entry.name ?? entry.email ?? entry.id,
    hint: [entry.role, entry.email].filter(Boolean).join(" · "),
  }));
}

/** Prefixes a role choice so it is distinguishable from a member id. */
export const ROLE_OPTION_PREFIX = "role:";

export function isRoleOption(value: string): boolean {
  return value.startsWith(ROLE_OPTION_PREFIX);
}

export function roleFromOption(value: string): string {
  return value.slice(ROLE_OPTION_PREFIX.length);
}

/**
 * Who to act as, offering roles as well as people.
 *
 * A role can be simulated without naming anyone, which is how a role-based rule
 * is tested before the organization has a member holding that role.
 */
export function actorOptions(
  members: readonly CatalogMember[]
): PolicyOption[] {
  return [
    ...POLICY_ROLES.map((role) => ({
      value: `${ROLE_OPTION_PREFIX}${role}`,
      label: `Any ${role}`,
      hint: "Anyone holding this role, without naming a person",
      group: "By role",
    })),
    ...memberOptions(members).map((option) => ({
      ...option,
      group: "Members",
    })),
  ];
}

export function chainOptions(catalog: PolicyCatalog): PolicyOption[] {
  return catalog.chains.map((chain) => ({
    value: String(chain.chainId),
    label: chain.name,
    hint: chain.isTestnet ? "Testnet" : undefined,
  }));
}

/** The resources a control-plane target can be narrowed to. */
export function resourceOptions(
  target: StatementTarget,
  catalog: PolicyCatalog
): PolicyOption[] {
  const list = TARGET_RESOURCE_LIST[target];
  if (list === "members") {
    return memberOptions(catalog.members);
  }
  if (list === "workflows") {
    return catalog.workflows.map((entry) => ({
      value: entry.id,
      label: entry.name,
    }));
  }
  if (list === "wallets") {
    return catalog.wallets.map((entry) => ({
      value: entry.id,
      label: shortAddress(entry.address),
      hint: `Chain ${entry.chainId}`,
    }));
  }
  return [];
}

/** Denominates a limit in dollars rather than in one asset's own units. */
export const USD_DENOMINATION = "usd";

/** Denominates a limit in the chain's own currency, with no oracle involved. */
export const NATIVE_DENOMINATION = "native";

/** Every tracked stablecoin, on every chain, as one identifier. */
export const ANY_STABLECOIN_DENOMINATION = "kh:asset/class/stablecoin";

/** Identifies a token across chains, since the same symbol has many addresses. */
export function tokenKey(token: CatalogToken): string {
  return `${token.chainId}:${token.address}`;
}

export function isTokenDenomination(denomination: string): boolean {
  return (
    denomination !== USD_DENOMINATION &&
    denomination !== NATIVE_DENOMINATION &&
    denomination !== ANY_STABLECOIN_DENOMINATION
  );
}

/** The asset a denomination names, for the fact a simulation carries. */
export function assetForDenomination(denomination: string): string | undefined {
  if (denomination === ANY_STABLECOIN_DENOMINATION) {
    return denomination;
  }
  if (!isTokenDenomination(denomination)) {
    return undefined;
  }
  const [, address] = denomination.split(":");
  return address || undefined;
}

function tokenGroup(token: CatalogToken, scoped: boolean): string {
  if (!scoped) {
    return "";
  }
  if (token.custom) {
    return "Your tokens";
  }
  return token.isStablecoin ? "Stablecoins" : "Other tracked tokens";
}

/**
 * What an amount can be counted in.
 *
 * With a chain chosen the list is that chain's tokens. Without one every chain
 * is offered, grouped by chain, because the same symbol exists on many chains
 * at different addresses and eleven rows reading "USDC" tell the reader nothing.
 */
export function denominationOptions(
  catalog: PolicyCatalog,
  chainId: number | null
): PolicyOption[] {
  const nativeLabel = catalog.chains.find(
    (chain) => chain.chainId === chainId
  )?.symbol;
  const chainName = new Map(
    catalog.chains.map((chain) => [chain.chainId, chain.name])
  );
  const scoped = chainId !== null;

  const tokens = catalog.tokens
    .filter((token) => !scoped || token.chainId === chainId)
    .map((token) => ({
      value: tokenKey(token),
      label: token.symbol,
      hint: `${token.name} · ${shortAddress(token.address)}`,
      group: scoped
        ? tokenGroup(token, true)
        : (chainName.get(token.chainId) ?? `Chain ${token.chainId}`),
    }));

  return [
    {
      value: NATIVE_DENOMINATION,
      label: nativeLabel
        ? `${nativeLabel} (native)`
        : "The chain's native currency",
      hint: "Read straight off the transaction, with no price involved",
      group: "Any asset",
    },
    {
      value: USD_DENOMINATION,
      label: "US dollars",
      hint: "Priced from an oracle at decision time, where a feed exists for the chain",
      group: "Any asset",
    },
    {
      value: ANY_STABLECOIN_DENOMINATION,
      label: "Any stablecoin",
      hint: "Every tracked stablecoin, on every chain",
      group: "Any asset",
    },
    ...tokens,
  ];
}
