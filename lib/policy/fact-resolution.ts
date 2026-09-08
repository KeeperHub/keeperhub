import { FactState, PolicyConditionKey } from "@/lib/policy/constants";
import type {
  AssetFact,
  CounterpartyFact,
  CounterpartyRole,
  Fact,
  PolicyFacts,
} from "@/lib/policy/types";

/**
 * Condition keys read a list-shaped fact.
 *
 * The vocabulary is singular because that is how a rule reads: "asset is one of
 * these". The facts are plural because a call can move more than one. Without
 * this mapping the engine looked up `facts.asset`, found nothing, and every
 * asset and counterparty rule silently matched nothing.
 */
const LIST_FACT_FOR_KEY: Readonly<Record<string, keyof PolicyFacts>> = {
  [PolicyConditionKey.ASSET]: "assets",
  [PolicyConditionKey.AMOUNT]: "assets",
  [PolicyConditionKey.COUNTERPARTY]: "counterparties",
  [PolicyConditionKey.RECIPIENT]: "counterparties",
  [PolicyConditionKey.SPENDER]: "counterparties",
  [PolicyConditionKey.WORKFLOW_TAG]: "workflowTags",
};

/** Counterparty keys that only read the entries holding one role. */
const ROLE_FOR_KEY: Readonly<Record<string, CounterpartyRole>> = {
  [PolicyConditionKey.RECIPIENT]: "recipient",
  [PolicyConditionKey.SPENDER]: "spender",
};

function assetValues(asset: AssetFact): string[] {
  // An asset rule can name the token by address or by symbol, and both are
  // what an author would reasonably write.
  return [asset.address, asset.symbol].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function counterpartyValues(entry: CounterpartyFact): string[] {
  return [entry.address, entry.label].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function flatten(key: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  if (key === PolicyConditionKey.ASSET) {
    return raw.flatMap((item) => assetValues(item as AssetFact));
  }
  if (key === PolicyConditionKey.AMOUNT) {
    // The raw amount in the asset's own units, which is what a rule denominated
    // in a token compares against.
    return raw
      .map((item) => (item as AssetFact).amount)
      .filter((value): value is string => typeof value === "string");
  }
  if (LIST_FACT_FOR_KEY[key] === "counterparties") {
    const role = ROLE_FOR_KEY[key];
    return raw
      .filter((item) => !role || (item as CounterpartyFact).role === role)
      .flatMap((item) => counterpartyValues(item as CounterpartyFact));
  }
  return raw.filter((item): item is string => typeof item === "string");
}

/**
 * The fact a condition key reads, flattened to the values a rule compares.
 *
 * Returns undefined when the key is not list-backed, so the caller falls back
 * to a direct lookup.
 */
export function readListFact(
  facts: PolicyFacts,
  key: string
): Fact<readonly string[]> | undefined {
  const field = LIST_FACT_FOR_KEY[key];
  if (!field) {
    return undefined;
  }

  const fact = facts[field] as Fact<unknown> | undefined;
  if (!fact || fact.state !== FactState.KNOWN) {
    // Absent and unknown pass straight through, so the fail-closed rule still
    // applies: a rule about assets refuses when the assets could not be read.
    return fact as Fact<readonly string[]> | undefined;
  }

  const values = flatten(key, fact.value);
  if (values.length === 0) {
    // The list was readable and holds nothing matching, which is a definite
    // absence rather than a failure to determine.
    return { state: FactState.ABSENT };
  }
  return { state: FactState.KNOWN, value: values, provenance: fact.provenance };
}
