import { ethers } from "ethers";
import {
  checkSolidityValue,
  isHashedIndexedType,
  isUnfilterableIndexedType,
} from "@/lib/web3/solidity-values";

/**
 * Turns the user's indexed-argument filter into the topic array
 * eth_getLogs takes, so the node filters at the RPC instead of fetching
 * every occurrence of the event and discarding most of it downstream.
 *
 * Topics are built here rather than through ethers' `contract.filters`
 * helper for two reasons. It refuses a negative value on a signed
 * parameter ("unsigned value cannot be negative") even though the topic is
 * well defined, and its errors name neither the parameter nor the step. A
 * topic for a value type is just that value ABI-encoded into one word, so
 * building it directly costs nothing and keeps both problems out.
 *
 * Every failure here is a configuration error, raised before any RPC call:
 * a filter the chain would silently never match is worse than one that
 * refuses to run.
 */

export type EventArgFilters = Record<string, string>;

export type EventArgFilterResult =
  | { success: true; topics: (string | null)[] | null; applied: string[] }
  | { success: false; error: string };

export type IndexedParam = {
  name: string;
  type: string;
  filterable: boolean;
  hashed: boolean;
};

/**
 * The parameters of `fragment` a filter may name, in topic order.
 *
 * An unnamed indexed parameter is dropped rather than given a positional
 * key. The filter is addressed by name on both sides, and a synthesised key
 * would have to agree between this module and the renderer for a parameter
 * the ABI itself does not name -- an agreement with nothing to anchor it.
 * Such a parameter is simply not filterable, and the panel says so.
 */
export function indexedParams(fragment: ethers.EventFragment): IndexedParam[] {
  return fragment.inputs
    .filter((input) => input.indexed && input.name)
    .map((input) => ({
      name: input.name,
      type: input.type,
      filterable: !isUnfilterableIndexedType(input.type),
      hashed: isHashedIndexedType(input.type),
    }));
}

/** Indexed parameters the ABI leaves unnamed, which cannot be addressed. */
export function unnamedIndexedCount(fragment: ethers.EventFragment): number {
  return fragment.inputs.filter((input) => input.indexed && !input.name).length;
}

/**
 * The 32-byte topic for one indexed value.
 *
 * A dynamic `string` or `bytes` is stored as the keccak hash of its
 * contents, not the contents, so the filter is exact-equality on the whole
 * value: no substring match, and the original cannot be read back out of
 * the log. Every other type is the value in one ABI word, which is what
 * gives negative signed values their correct two's-complement topic.
 */
function encodeTopic(type: string, value: string): string {
  if (type === "string") {
    return ethers.keccak256(ethers.toUtf8Bytes(value));
  }
  if (type === "bytes") {
    return ethers.keccak256(value);
  }
  return ethers.AbiCoder.defaultAbiCoder().encode([type], [coerce(type, value)]);
}

function coerce(type: string, value: string): unknown {
  if (type === "bool") {
    return value === "true";
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return BigInt(value);
  }
  if (type === "address") {
    // The shape check upstream is ethers-free, so it admits a mixed-case
    // address that is not EIP-55 valid; ethers would then reject it inside
    // the encoder. Lowercasing is what the topic encodes anyway, and a
    // checksum is a transcription aid rather than part of the value.
    return value.toLowerCase();
  }
  return value;
}

function parseFilterObject(
  raw: string
): { success: true; filters: EventArgFilters } | { success: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      success: false,
      error:
        "Event argument filter is not valid JSON. Expected an object of indexed parameter names to values.",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      success: false,
      error:
        "Event argument filter must be a JSON object keyed by indexed parameter name.",
    };
  }
  return collectFilters(parsed as Record<string, unknown>);
}

/**
 * Narrow the raw object to named, non-empty values.
 *
 * A key that is present but empty is an error rather than a wildcard. The
 * difference matters because of templates: `{"to": "{{Lookup.address}}"}`
 * where the upstream node returns an empty string would otherwise drop the
 * only filter and scan the whole range unfiltered, returning every event as
 * though the filter had matched everything. Omitting the key is the one way
 * to mean "any value", and it is the shape the panel writes.
 */
function collectFilters(
  raw: Record<string, unknown>
): { success: true; filters: EventArgFilters } | { success: false; error: string } {
  // No prototype, so a parameter named `toString` or `__proto__` is looked up
  // as the user's key and never as an inherited member.
  const filters: EventArgFilters = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) {
      return {
        success: false,
        error: `Filter for '${key}' is empty. Remove the parameter to match any value for it.`,
      };
    }
    if (typeof value === "object") {
      return {
        success: false,
        error: `Filter for '${key}' must be a single value, not an object or array.`,
      };
    }
    // Kept verbatim: whether surrounding whitespace is part of the value
    // depends on the parameter's type, which is only known in finishTopics.
    const text = String(value);
    if (text === "") {
      return {
        success: false,
        error: `Filter for '${key}' is empty. Remove the parameter to match any value for it.`,
      };
    }
    filters[key] = text;
  }
  return { success: true, filters };
}

/**
 * Build the eth_getLogs topic array for `fragment` from the user's filter.
 *
 * Returns `topics: null` when nothing is being filtered, so the caller can
 * keep its existing unfiltered path rather than sending a topic array that
 * only carries the event signature.
 */
export function buildEventArgTopics(
  raw: string | Record<string, unknown> | undefined,
  fragment: ethers.EventFragment
): EventArgFilterResult {
  if (raw === undefined || raw === null) {
    return { success: true, topics: null, applied: [] };
  }
  // The config field accepts a record as well as a JSON string: the editor
  // stores the string, while an agent or API caller can store the object.
  if (typeof raw !== "string") {
    if (Array.isArray(raw)) {
      return {
        success: false,
        error:
          "Event argument filter must be a JSON object keyed by indexed parameter name.",
      };
    }
    return finishTopics(collectFilters(raw), fragment);
  }
  if (raw.trim() === "") {
    return { success: true, topics: null, applied: [] };
  }

  return finishTopics(parseFilterObject(raw), fragment);
}

function finishTopics(
  parsed:
    | { success: true; filters: EventArgFilters }
    | { success: false; error: string },
  fragment: ethers.EventFragment
): EventArgFilterResult {
  if (!parsed.success) {
    return parsed;
  }
  const entries = Object.entries(parsed.filters);
  if (entries.length === 0) {
    return { success: true, topics: null, applied: [] };
  }

  const indexed = indexedParams(fragment);
  const byName = new Map(indexed.map((param) => [param.name, param]));
  const names = indexed
    .filter((param) => param.filterable)
    .map((param) => param.name);
  const nameList = names.length > 0 ? names.join(", ") : "none";

  // Values as they will be encoded, keyed by parameter name.
  const normalized = new Map<string, string>();
  for (const [key, rawValue] of entries) {
    const param = byName.get(key);
    if (!param) {
      const known = fragment.inputs.find((input) => input.name === key);
      const unnamed = unnamedIndexedCount(fragment);
      const unnamedNote =
        unnamed > 0
          ? ` ${unnamed} indexed parameter(s) of ${fragment.name} are unnamed in the ABI and cannot be filtered by name.`
          : "";
      return {
        success: false,
        error: known
          ? `'${key}' is not an indexed parameter of ${fragment.name}, and only indexed parameters can be filtered at the RPC. Filterable here: ${nameList}.${unnamedNote}`
          : `'${key}' is not a parameter of ${fragment.name}. Filterable here: ${nameList}.${unnamedNote}`,
      };
    }
    if (!param.filterable) {
      return {
        success: false,
        error: `'${key}' is an indexed ${param.type}, whose topic is a hash of the encoded contents rather than a value that can be matched. Filterable here: ${nameList}.`,
      };
    }
    // An indexed string is hashed as UTF-8, so whitespace is part of the
    // value and " urgent" must not match "urgent". Every other type is a
    // scalar a pasted value may carry stray whitespace around.
    const value = param.type === "string" ? rawValue : rawValue.trim();
    if (value === "") {
      return {
        success: false,
        error: `Filter for '${key}' is empty. Remove the parameter to match any value for it.`,
      };
    }
    const check = checkSolidityValue(param.type, value);
    if (!check.valid) {
      return {
        success: false,
        error: `Filter for '${key}' (${param.type}) must be ${check.expected}.`,
      };
    }
    normalized.set(key, value);
  }

  // Every indexed input holds a topic slot, named or not, so the positions
  // are taken from the fragment rather than from the filterable subset: an
  // unnamed parameter ahead of a filtered one would otherwise shift the
  // value onto the wrong topic.
  const topics: (string | null)[] = [fragment.topicHash];
  for (const input of fragment.inputs.filter((i) => i.indexed)) {
    const value = input.name ? normalized.get(input.name) : undefined;
    if (value === undefined) {
      topics.push(null);
      continue;
    }
    try {
      topics.push(encodeTopic(input.type, value));
    } catch (error) {
      return {
        success: false,
        error: `Filter for '${input.name}' (${input.type}) could not be encoded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  // Trailing wildcards say nothing; dropping them keeps the topic array the
  // shortest one that expresses the same filter.
  while (topics.length > 0 && topics.at(-1) === null) {
    topics.pop();
  }

  return {
    success: true,
    topics,
    applied: entries.map(([key]) => key),
  };
}
