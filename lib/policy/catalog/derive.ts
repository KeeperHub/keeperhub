import type { AbiEntry, AbiFunctionEntry } from "@/lib/abi/types";
import { canonicalSignature, computeSelector } from "@/lib/abi/utils";
import { Capability } from "@/lib/policy/capabilities";
import { capabilityForWriteVerb } from "@/lib/policy/capability-verbs";
import {
  LIMIT_BEARING_RISK_CLASSES,
  PolicyRiskClass,
  RISK_CLASS_CONDITION_KEYS,
  SelectorParameterRole,
} from "@/lib/policy/catalog/constants";
import { applyOverride } from "@/lib/policy/catalog/overrides";
import { deriveParameterRoles } from "@/lib/policy/catalog/parameters";
import {
  deriveRiskClass,
  isDispatcherFunction,
} from "@/lib/policy/catalog/risk-class";
import {
  CatalogEntrySource,
  type ContractCatalog,
  type SelectorCatalogEntry,
} from "@/lib/policy/catalog/types";
import { PolicyConditionKey } from "@/lib/policy/constants";

function isFunctionEntry(entry: AbiEntry): entry is AbiFunctionEntry {
  return entry.type === "function" && typeof entry.name === "string";
}

/** An amount is readable from a named amount parameter or from native value. */
function hasAmountSource(
  roles: readonly SelectorParameterRole[],
  entry: AbiFunctionEntry
): boolean {
  return (
    roles.includes(SelectorParameterRole.AMOUNT) ||
    entry.stateMutability === "payable"
  );
}

/**
 * Whether a condition key can bind, given what this function exposes.
 *
 * Asset and counterparty are kept regardless of parameters because both are
 * read from the contract being called, not from an argument: an ERC-20
 * transfer names its asset by the address it is sent to.
 */
function keyBinds(
  key: PolicyConditionKey,
  entry: AbiFunctionEntry,
  roles: readonly SelectorParameterRole[]
): boolean {
  switch (key) {
    case PolicyConditionKey.RECIPIENT:
      return roles.includes(SelectorParameterRole.RECIPIENT);
    case PolicyConditionKey.SPENDER:
      return roles.includes(SelectorParameterRole.SPENDER);
    case PolicyConditionKey.AMOUNT:
    case PolicyConditionKey.USD_VALUE:
      return hasAmountSource(roles, entry);
    default:
      return true;
  }
}

function conditionKeysFor(
  riskClass: PolicyRiskClass,
  entry: AbiFunctionEntry,
  roles: readonly SelectorParameterRole[]
): readonly PolicyConditionKey[] {
  return RISK_CLASS_CONDITION_KEYS[riskClass].filter((key) =>
    keyBinds(key, entry, roles)
  );
}

/**
 * The capability a function exercises.
 *
 * Read functions are contract reads. Everything else takes the verb its ABI
 * name declares, so Aave's `supply` is a lending supply whether it is reached
 * through a protocol plugin node or a raw contract write. A write naming no
 * recognised verb is a plain contract write, which is accurate rather than
 * flattering.
 */
function capabilityForEntry(
  entry: AbiFunctionEntry,
  riskClass: PolicyRiskClass
): string {
  if (riskClass === PolicyRiskClass.READ) {
    return Capability.CONTRACT_READ;
  }
  return capabilityForWriteVerb(entry.name) ?? Capability.CONTRACT_WRITE;
}

/** Derive a catalog entry from one ABI function. */
export function deriveEntry(entry: AbiFunctionEntry): SelectorCatalogEntry {
  const inputs = entry.inputs ?? [];
  const riskClass = deriveRiskClass(entry);
  const parameterRoles = deriveParameterRoles(inputs);
  const conditionKeys = conditionKeysFor(riskClass, entry, parameterRoles);

  return {
    selector: computeSelector(entry.name, inputs).toLowerCase(),
    name: entry.name,
    signature: canonicalSignature(entry.name, inputs),
    stateMutability: entry.stateMutability,
    riskClass,
    capability: capabilityForEntry(entry, riskClass),
    conditionKeys,
    supportsLimits:
      LIMIT_BEARING_RISK_CLASSES.includes(riskClass) &&
      hasAmountSource(parameterRoles, entry),
    parameterRoles,
    isDispatcher: isDispatcherFunction(entry),
    source: CatalogEntrySource.DERIVED,
  };
}

function findCollisions(
  entries: readonly SelectorCatalogEntry[]
): readonly string[] {
  const seen = new Set<string>();
  const collided = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.selector)) {
      collided.add(entry.selector);
    }
    seen.add(entry.selector);
  }
  return [...collided];
}

export type DeriveCatalogInput = {
  chainId: number;
  address: string;
  abi: readonly AbiEntry[];
  implementationAddress?: string | null;
  /** Applies protocol-scoped overrides when the contract belongs to one. */
  protocolSlug?: string;
};

/**
 * Build a contract catalog from a parsed ABI.
 *
 * The address pins what appears as `to` on the wire, which for an upgradeable
 * protocol is the proxy. The ABI is expected to be the implementation's, since
 * that is what lists the callable functions.
 */
export function deriveContractCatalog(
  input: DeriveCatalogInput
): ContractCatalog {
  const entries = input.abi
    .filter(isFunctionEntry)
    .map((entry) => applyOverride(deriveEntry(entry), input.protocolSlug));
  return {
    chainId: input.chainId,
    address: input.address.toLowerCase(),
    implementationAddress: input.implementationAddress?.toLowerCase() ?? null,
    entries,
    collisions: findCollisions(entries),
  };
}
