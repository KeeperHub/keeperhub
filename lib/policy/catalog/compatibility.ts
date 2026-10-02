import {
  ARN_WILDCARD_DEEP,
  ARN_WILDCARD_SEGMENT,
  ArnSegment,
  parseArn,
} from "@/lib/policy";
import {
  AMBIENT_CONDITION_KEYS,
  LIMIT_BEARING_RISK_CLASSES,
} from "@/lib/policy/catalog/constants";
import type {
  ContractCatalog,
  SelectorCatalogEntry,
} from "@/lib/policy/catalog/types";
import type { PolicyConditionKey } from "@/lib/policy/constants";
import { PolicyEffect } from "@/lib/policy/constants";
import type { PolicyStatement } from "@/lib/policy/types";

export const CompatibilitySeverity = {
  /**
   * The statement, or the whole of one of its sections, grants nothing. AWS
   * treats this as blocking because the author almost certainly meant
   * something else.
   */
  ERROR: "error",
  /** Part of the statement matches nothing. The rest still applies. */
  WARNING: "warning",
  /** Well-formed and enforceable, but worth a second look. */
  SECURITY: "security",
} as const;

export type CompatibilitySeverity =
  (typeof CompatibilitySeverity)[keyof typeof CompatibilitySeverity];

export const CompatibilityCode = {
  SELECTOR_NOT_ON_CONTRACT: "selector-not-on-contract",
  CAPABILITY_MISMATCH: "capability-mismatch",
  RESOURCE_MATCHES_NO_SELECTOR: "resource-matches-no-selector",
  IMPLEMENTATION_NOT_PROXY: "implementation-not-proxy",
  CONDITION_BINDS_NOTHING: "condition-binds-nothing",
  LIMIT_BINDS_NOTHING: "limit-binds-nothing",
  UNLIMITED_VALUE_ALLOW: "unlimited-value-allow",
  STATEMENT_MATCHES_NOTHING: "statement-matches-nothing",
  CHAIN_MISMATCH: "chain-mismatch",
  CONTRACT_UNVERIFIED: "contract-unverified",
  SELECTOR_COLLISION: "selector-collision",
  DISPATCHER_PERMITTED: "dispatcher-permitted",
} as const;

export type CompatibilityCode =
  (typeof CompatibilityCode)[keyof typeof CompatibilityCode];

export type CompatibilityFinding = {
  code: CompatibilityCode;
  severity: CompatibilitySeverity;
  /** The statement this finding belongs to. */
  sid: string;
  /** The field within the statement, so the editor can focus it. */
  field: "resource" | "condition" | "limit" | "capability";
  message: string;
  /** The exact resource, condition key, or selector at fault. */
  subject?: string;
};

/** A resource pattern paired with the catalog of the contract it names. */
export type ResolvedResource = {
  /** The resource pattern exactly as authored. */
  pattern: string;
  chainId: number | null;
  address: string | null;
  /** The selector the pattern pins, or null when it is open or wildcarded. */
  selector: string | null;
  /** Null when the pattern names no concrete contract. */
  catalog: ContractCatalog | null;
};

function isWildcard(value: string): boolean {
  return value === ARN_WILDCARD_SEGMENT || value === ARN_WILDCARD_DEEP;
}

/** Reads chain, contract and selector out of a resource pattern. */
export function describeResource(pattern: string | undefined): {
  chainId: number | null;
  address: string | null;
  selector: string | null;
} {
  // A statement can legitimately name no resource: an offchain rule never does,
  // and an onchain rule being built has not chosen a contract yet.
  if (!pattern) {
    return { chainId: null, address: null, selector: null };
  }
  const result = parseArn(pattern);
  if (!result.ok) {
    return { chainId: null, address: null, selector: null };
  }

  let chainId: number | null = null;
  let address: string | null = null;
  let selector: string | null = null;

  for (const part of result.arn.parts) {
    if (part.type === ArnSegment.CHAIN && !isWildcard(part.id)) {
      const value = Number(part.id);
      chainId = Number.isInteger(value) ? value : null;
    }
    if (part.type === ArnSegment.CONTRACT && !isWildcard(part.id)) {
      address = part.id;
    }
    if (part.type === ArnSegment.FUNCTION && !isWildcard(part.id)) {
      selector = part.id;
    }
  }

  return { chainId, address, selector };
}

/** The catalog entries a resource pattern actually selects. */
function selectedEntries(
  resource: ResolvedResource
): readonly SelectorCatalogEntry[] {
  if (!resource.catalog) {
    return [];
  }
  const writes = resource.catalog.entries.filter(
    (entry) =>
      entry.stateMutability !== "view" && entry.stateMutability !== "pure"
  );
  if (resource.selector === null) {
    return writes;
  }
  return writes.filter((entry) => entry.selector === resource.selector);
}

function checkResource(
  statement: PolicyStatement,
  resource: ResolvedResource
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];

  // Naming the implementation instead of the proxy is the quietest way to
  // write a rule that governs nothing: the transaction is sent to the proxy, so
  // an identifier pinned to the address behind it never matches.
  if (resource.address && resource.catalog?.proxiedBy) {
    findings.push({
      code: CompatibilityCode.IMPLEMENTATION_NOT_PROXY,
      severity: CompatibilitySeverity.ERROR,
      sid: statement.sid,
      field: "resource",
      subject: resource.pattern,
      message: `This is the implementation behind ${resource.catalog.proxiedBy}, not the address calls are sent to. Name the proxy instead, or this rule matches nothing.`,
    });
    return findings;
  }

  if (resource.address && resource.catalog?.entries.length === 0) {
    findings.push({
      code: CompatibilityCode.CONTRACT_UNVERIFIED,
      severity: CompatibilitySeverity.WARNING,
      sid: statement.sid,
      field: "resource",
      subject: resource.pattern,
      message:
        "Nothing describes this contract, so its functions cannot be listed. The rule still applies, but nothing can check that the selector exists.",
    });
    return findings;
  }

  const entries = selectedEntries(resource);

  if (resource.selector !== null && entries.length === 0 && resource.catalog) {
    findings.push({
      code: CompatibilityCode.SELECTOR_NOT_ON_CONTRACT,
      severity: CompatibilitySeverity.ERROR,
      sid: statement.sid,
      field: "resource",
      subject: resource.pattern,
      message: `No function with selector ${resource.selector} exists on this contract, so this resource matches nothing.`,
    });
    return findings;
  }

  if (entries.length === 0 && resource.catalog) {
    findings.push({
      code: CompatibilityCode.RESOURCE_MATCHES_NO_SELECTOR,
      severity: CompatibilitySeverity.WARNING,
      sid: statement.sid,
      field: "resource",
      subject: resource.pattern,
      message:
        "This contract exposes no state-changing functions, so the resource selects nothing a policy can govern.",
    });
  }

  for (const entry of entries) {
    if (resource.catalog?.collisions.includes(entry.selector)) {
      findings.push({
        code: CompatibilityCode.SELECTOR_COLLISION,
        severity: CompatibilitySeverity.SECURITY,
        sid: statement.sid,
        field: "resource",
        subject: entry.selector,
        message: `Selector ${entry.selector} is exposed by more than one function on this contract. A rule naming it covers all of them.`,
      });
    }
    if (entry.isDispatcher && statement.effect === PolicyEffect.ALLOW) {
      findings.push({
        code: CompatibilityCode.DISPATCHER_PERMITTED,
        severity: CompatibilitySeverity.SECURITY,
        sid: statement.sid,
        field: "resource",
        subject: entry.signature,
        message: `${entry.name} forwards arbitrary calls, so allowing it permits everything this contract can reach, not only the selector named here.`,
      });
    }
  }

  return findings;
}

function checkChainConsistency(
  statement: PolicyStatement,
  resources: readonly ResolvedResource[]
): CompatibilityFinding[] {
  const chains = new Set(
    resources
      .map((resource) => resource.chainId)
      .filter((chainId): chainId is number => chainId !== null)
  );
  if (chains.size < 2) {
    return [];
  }
  return [
    {
      code: CompatibilityCode.CHAIN_MISMATCH,
      severity: CompatibilitySeverity.WARNING,
      sid: statement.sid,
      field: "resource",
      message: `This statement spans chains ${[...chains].sort((a, b) => a - b).join(", ")}. A condition that holds on one chain may bind nothing on another.`,
    },
  ];
}

function bindableKeys(
  entries: readonly SelectorCatalogEntry[]
): Set<PolicyConditionKey> {
  const keys = new Set<PolicyConditionKey>(AMBIENT_CONDITION_KEYS);
  for (const entry of entries) {
    for (const key of entry.conditionKeys) {
      keys.add(key);
    }
  }
  return keys;
}

function checkConditions(
  statement: PolicyStatement,
  entries: readonly SelectorCatalogEntry[]
): CompatibilityFinding[] {
  if (!statement.condition || entries.length === 0) {
    return [];
  }
  const bindable = bindableKeys(entries);
  const findings: CompatibilityFinding[] = [];

  for (const key of Object.keys(statement.condition)) {
    if (key.startsWith("signal.") || bindable.has(key as PolicyConditionKey)) {
      continue;
    }
    findings.push({
      code: CompatibilityCode.CONDITION_BINDS_NOTHING,
      severity: CompatibilitySeverity.WARNING,
      sid: statement.sid,
      field: "condition",
      subject: key,
      message: `None of the selected functions expose "${key}", so this condition can never be read for them.`,
    });
  }
  return findings;
}

function checkLimits(
  statement: PolicyStatement,
  entries: readonly SelectorCatalogEntry[]
): CompatibilityFinding[] {
  if (!statement.limit?.length || entries.length === 0) {
    return [];
  }
  const anyLimitBearing = entries.some(
    (entry) =>
      entry.supportsLimits &&
      LIMIT_BEARING_RISK_CLASSES.includes(entry.riskClass)
  );
  if (anyLimitBearing) {
    return [];
  }
  return [
    {
      code: CompatibilityCode.LIMIT_BINDS_NOTHING,
      severity: CompatibilitySeverity.WARNING,
      sid: statement.sid,
      field: "limit",
      message:
        "None of the selected functions move a measurable amount, so this limit never charges anything.",
    },
  ];
}

/**
 * A statement whose verb does not match the functions it names.
 *
 * The capability is a gate: a statement whose capability list does not include
 * the one a request carries never matches, whatever its resource says. So a
 * rule can name exactly the right contract and the right function and still do
 * nothing, with nothing about it looking wrong.
 *
 * Which way that fails depends on the effect, and neither is good. A permission
 * that never matches refuses work the author meant to allow. A prohibition that
 * never matches is inert, and is only covered at all because a claimed scope
 * refuses by default.
 */
function checkCapabilities(
  statement: PolicyStatement,
  entries: readonly SelectorCatalogEntry[]
): CompatibilityFinding[] {
  if (entries.length === 0 || statement.capability.length === 0) {
    return [];
  }

  const named = new Set(statement.capability);
  const unreachable = entries.filter((entry) => !named.has(entry.capability));
  if (unreachable.length === 0 || unreachable.length < entries.length) {
    // A partial mismatch is covered by the per-function report below; this is
    // for the case where the statement can match none of them.
    return unreachable.length === 0
      ? []
      : [
          {
            code: CompatibilityCode.CAPABILITY_MISMATCH,
            severity: CompatibilitySeverity.WARNING,
            sid: statement.sid,
            field: "capability",
            subject: unreachable[0]?.signature,
            message: `${unreachable.length} of the selected functions are not covered by this rule's action, so it does not apply to them. Add ${unreachable[0]?.capability} to cover them.`,
          },
        ];
  }

  return [
    {
      code: CompatibilityCode.CAPABILITY_MISMATCH,
      severity: CompatibilitySeverity.ERROR,
      sid: statement.sid,
      field: "capability",
      subject: entries[0]?.signature,
      message: `This rule's action does not cover any function it names, so it never applies. The functions selected are ${[...new Set(entries.map((e) => e.capability))].join(", ")}.`,
    },
  ];
}

/**
 * An allow over functions that move value, with nothing capping how much.
 *
 * Legal and enforceable, so not an error, but it is the difference between "may
 * supply to Aave" and "may supply the entire treasury to Aave", which is worth
 * saying out loud before it is saved.
 */
function checkUnlimitedValue(
  statement: PolicyStatement,
  entries: readonly SelectorCatalogEntry[]
): CompatibilityFinding[] {
  if (statement.effect !== PolicyEffect.ALLOW || statement.limit?.length) {
    return [];
  }
  const valueMoving = entries.filter((entry) => entry.supportsLimits);
  if (valueMoving.length === 0) {
    return [];
  }
  return [
    {
      code: CompatibilityCode.UNLIMITED_VALUE_ALLOW,
      severity: CompatibilitySeverity.SECURITY,
      sid: statement.sid,
      field: "limit",
      message: `This allows ${valueMoving.length} function${valueMoving.length === 1 ? "" : "s"} that move value, with no limit on how much.`,
    },
  ];
}

/**
 * Compatibility findings for one statement.
 *
 * The severity split follows AWS: a statement that grants nothing at all is an
 * error, because the author cannot have meant it; a statement where only part
 * matches nothing is a warning, because the rest still applies. Findings never
 * block on their own, they are counted and rendered by the editor.
 */
export function checkStatement(
  statement: PolicyStatement,
  resources: readonly ResolvedResource[]
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];

  for (const resource of resources) {
    findings.push(...checkResource(statement, resource));
  }
  findings.push(...checkChainConsistency(statement, resources));

  const entries = resources.flatMap((resource) => selectedEntries(resource));
  findings.push(...checkCapabilities(statement, entries));
  findings.push(...checkConditions(statement, entries));
  findings.push(...checkLimits(statement, entries));
  findings.push(...checkUnlimitedValue(statement, entries));

  const everyResourceEmpty =
    resources.length > 0 &&
    resources.every((resource) => resource.catalog !== null) &&
    entries.length === 0;

  if (everyResourceEmpty) {
    findings.push({
      code: CompatibilityCode.STATEMENT_MATCHES_NOTHING,
      severity: CompatibilitySeverity.ERROR,
      sid: statement.sid,
      field: "resource",
      message:
        "No resource in this statement selects a function that exists, so the statement has no effect.",
    });
  }

  return findings;
}
