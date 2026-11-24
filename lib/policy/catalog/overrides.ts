import type { PolicyRiskClass } from "@/lib/policy/catalog/constants";
import {
  CatalogEntrySource,
  type SelectorCatalogEntry,
} from "@/lib/policy/catalog/types";
import type { PolicyConditionKey } from "@/lib/policy/constants";

/**
 * Editorial correction for one selector.
 *
 * The derivation reads an ABI and applies name rules, which is right often
 * enough to be useful and wrong often enough to need this layer. Every field
 * is optional; only what is stated is corrected.
 */
export type SelectorOverride = {
  riskClass?: PolicyRiskClass;
  conditionKeys?: readonly PolicyConditionKey[];
  supportsLimits?: boolean;
  isDispatcher?: boolean;
  /** Why the derived value was wrong. Required, so the table stays reviewable. */
  reason: string;
};

/**
 * Overrides keyed by canonical signature, applied to every contract.
 *
 * Deliberately near-empty. Entries earn their place by a test failing, not by
 * anticipation: a speculative override is a guess with more authority than the
 * heuristic it replaces.
 */
export const GLOBAL_OVERRIDES: Readonly<Record<string, SelectorOverride>> = {};

/** Overrides scoped to one protocol, keyed by protocol slug then signature. */
export const PROTOCOL_OVERRIDES: Readonly<
  Record<string, Readonly<Record<string, SelectorOverride>>>
> = {};

function lookup(
  signature: string,
  protocolSlug?: string
): SelectorOverride | undefined {
  if (protocolSlug) {
    const scoped = PROTOCOL_OVERRIDES[protocolSlug]?.[signature];
    if (scoped) {
      return scoped;
    }
  }
  return GLOBAL_OVERRIDES[signature];
}

/**
 * Apply any editorial override to a derived entry.
 *
 * A protocol-scoped override wins over a global one. An entry that no override
 * touches is returned unchanged, keeping its `derived` source.
 */
export function applyOverride(
  entry: SelectorCatalogEntry,
  protocolSlug?: string
): SelectorCatalogEntry {
  const override = lookup(entry.signature, protocolSlug);
  if (!override) {
    return entry;
  }

  return {
    ...entry,
    riskClass: override.riskClass ?? entry.riskClass,
    conditionKeys: override.conditionKeys ?? entry.conditionKeys,
    supportsLimits: override.supportsLimits ?? entry.supportsLimits,
    isDispatcher: override.isDispatcher ?? entry.isDispatcher,
    source: CatalogEntrySource.OVERRIDE,
  };
}
