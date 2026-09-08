import { ARN_WILDCARD_SEGMENT, ArnSegment } from "@/lib/policy/arn";
import {
  CAPABILITIES,
  type Capability,
  getCapabilitiesByPlane,
  isOnchainCapability,
} from "@/lib/policy/capabilities";
import { PolicyPlane } from "@/lib/policy/constants";

/**
 * The kind of thing a rule governs.
 *
 * Onchain rules name a contract and its functions. Control-plane rules name a
 * resource the organization owns and what may be done to it. Both compile to
 * the same statement shape; only the pickers differ.
 */
export const StatementTarget = {
  ONCHAIN: "onchain",
  /** What a workflow does that does not touch a chain. */
  OFFCHAIN: "offchain",
  WORKFLOW: ArnSegment.WORKFLOW,
  WALLET: ArnSegment.WALLET,
  MEMBER: ArnSegment.MEMBER,
  INTEGRATION: ArnSegment.INTEGRATION,
  ADDRESSBOOK: ArnSegment.ADDRESSBOOK,
  APIKEY: ArnSegment.APIKEY,
  POLICY: ArnSegment.POLICY,
} as const;

export type StatementTarget =
  (typeof StatementTarget)[keyof typeof StatementTarget];

export const STATEMENT_TARGET_LABEL: Record<StatementTarget, string> = {
  [StatementTarget.ONCHAIN]: "An onchain call",
  [StatementTarget.OFFCHAIN]: "An offchain action",
  [StatementTarget.WORKFLOW]: "Workflows",
  [StatementTarget.WALLET]: "Safes",
  [StatementTarget.MEMBER]: "Members",
  [StatementTarget.INTEGRATION]: "Connections",
  [StatementTarget.ADDRESSBOOK]: "Address book",
  [StatementTarget.APIKEY]: "API keys",
  [StatementTarget.POLICY]: "Policies",
};

/**
 * The singular form, for a field that narrows a rule to one of them.
 *
 * "Which one" on its own says nothing: the reader has to remember what kind of
 * thing the rule is about to know what they are being asked for.
 */
export const STATEMENT_TARGET_SINGULAR: Partial<
  Record<StatementTarget, string>
> = {
  [StatementTarget.WORKFLOW]: "workflow",
  [StatementTarget.WALLET]: "Safe",
  [StatementTarget.MEMBER]: "member",
  [StatementTarget.INTEGRATION]: "connection",
  [StatementTarget.ADDRESSBOOK]: "address book entry",
  [StatementTarget.APIKEY]: "API key",
  [StatementTarget.POLICY]: "policy",
};

/** What each control-plane target governs, shown under its name. */
export const STATEMENT_TARGET_HINT: Partial<Record<StatementTarget, string>> = {
  [StatementTarget.OFFCHAIN]:
    "Calling an external endpoint, sending a notification, or querying a database. These move no value and touch no chain, so they carry no contract or amount.",
  [StatementTarget.WORKFLOW]:
    "Who may create, edit, publish or delete a workflow.",
  [StatementTarget.WALLET]:
    "Who may deploy or remove a Safe, and who may widen its onchain permission scope. The organization's managed signer is provisioned automatically and cannot be added or removed, so these rules govern Safes.",
  [StatementTarget.MEMBER]: "Who may invite, change or remove a member.",
  [StatementTarget.INTEGRATION]:
    "Who may add or change a stored credential, such as Discord, Slack, Telegram, Safe or a database connection.",
  [StatementTarget.ADDRESSBOOK]:
    "Who may add a counterparty. Without this, a counterparty allowlist means little.",
  [StatementTarget.APIKEY]: "Who may issue or revoke an API key.",
  [StatementTarget.POLICY]:
    "Who may edit policy itself. Any rule means little if whoever it constrains can edit it.",
};

/** The capability prefix that maps onto each control-plane target. */
const TARGET_PREFIX: Partial<Record<StatementTarget, string>> = {
  [StatementTarget.WORKFLOW]: "workflow.",
  [StatementTarget.WALLET]: "wallet.",
  [StatementTarget.MEMBER]: "member.",
  [StatementTarget.INTEGRATION]: "integration.",
  [StatementTarget.ADDRESSBOOK]: "addressbook.",
  [StatementTarget.APIKEY]: "apikey.",
  [StatementTarget.POLICY]: "policy.",
};

/** Every control-plane target, in the order the picker offers them. */
export const CONTROL_TARGETS: readonly StatementTarget[] = [
  StatementTarget.WORKFLOW,
  StatementTarget.WALLET,
  StatementTarget.MEMBER,
  StatementTarget.INTEGRATION,
  StatementTarget.ADDRESSBOOK,
  StatementTarget.APIKEY,
  StatementTarget.POLICY,
];

/** The capabilities a control-plane target can be governed by. */
export function capabilitiesForTarget(
  target: StatementTarget
): readonly Capability[] {
  if (target === StatementTarget.OFFCHAIN) {
    return getCapabilitiesByPlane(PolicyPlane.DATA).filter(
      (capability) => !isOnchainCapability(capability)
    );
  }
  const prefix = TARGET_PREFIX[target];
  if (!prefix) {
    return [];
  }
  return getCapabilitiesByPlane(PolicyPlane.CONTROL).filter((capability) =>
    capability.startsWith(prefix)
  );
}

/** The target a control-plane capability belongs to, or null for onchain ones. */
export function targetForCapability(
  capability: string
): StatementTarget | null {
  for (const target of CONTROL_TARGETS) {
    const prefix = TARGET_PREFIX[target];
    if (prefix && capability.startsWith(prefix)) {
      return target;
    }
  }
  return null;
}

export function capabilityLabel(capability: Capability): string {
  return CAPABILITIES[capability]?.label ?? capability;
}

/**
 * The identifier for a control-plane resource.
 *
 * `*` covers every resource of that kind, which is what a rule about "wallets"
 * rather than "this wallet" means. A specific id narrows it to one.
 */
export function buildControlResourceArn(
  target: StatementTarget,
  resourceId?: string
): string {
  const id = resourceId && resourceId.length > 0 ? resourceId : "*";
  return `kh:${target}/${id}`;
}

/**
 * The scope a control-plane rule claims.
 *
 * Always every resource of that kind, never the single id a statement allows.
 * Claiming only the named resource would leave every other wallet, member or
 * key unmanaged, which inverts what the author asked for.
 */
export function buildControlManagedScope(target: StatementTarget): string {
  // A single-segment wildcard, not the deep one: the grammar only accepts `**`
  // as a trailing segment of its own, so "kh:wallet/**" does not parse and a
  // managed scope that does not parse is refused at compile time. One segment
  // is also all a control-plane identifier has.
  return `kh:${target}/${ARN_WILDCARD_SEGMENT}`;
}

/**
 * Capabilities that create something.
 *
 * A creation cannot be narrowed to the thing being created, because it does not
 * exist yet and has no id. Offering a "which one" box for these asks a question
 * with no answer; the meaningful scope is where it is being created.
 */
const CREATE_CAPABILITY_SUFFIX = ".create";

export function isCreateCapability(capability: string): boolean {
  return (
    capability.endsWith(CREATE_CAPABILITY_SUFFIX) ||
    capability === "member.invite"
  );
}

/**
 * Whether every chosen capability creates something, in which case naming a
 * single resource is impossible rather than merely optional.
 */
export function onlyCreates(capabilities: readonly string[]): boolean {
  return (
    capabilities.length > 0 && capabilities.every((c) => isCreateCapability(c))
  );
}

/** Targets that name no organization resource, so "which one" has no answer. */
export function hasNamedResource(target: StatementTarget): boolean {
  return target !== StatementTarget.OFFCHAIN;
}

/** Targets whose objects live in a project and carry tags. */
export function supportsProjectScope(target: StatementTarget): boolean {
  return target === StatementTarget.WORKFLOW;
}

/**
 * Which catalog list holds the resources a target can be narrowed to.
 *
 * A target with a list gets a picker; one without keeps a plain field, because
 * an empty picker is worse than a text box. Nothing here is guessed: the key
 * names a list the catalog actually serves.
 */
export const TARGET_RESOURCE_LIST: Partial<
  Record<StatementTarget, "members" | "workflows" | "wallets">
> = {
  [StatementTarget.MEMBER]: "members",
  [StatementTarget.WORKFLOW]: "workflows",
  [StatementTarget.WALLET]: "wallets",
};
