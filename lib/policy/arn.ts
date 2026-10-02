/**
 * The resource identifier grammar.
 *
 * Two namespaces. The organization is implicit, since policies are org-scoped,
 * so it never appears in an identifier.
 *
 *   cap:<dotted.path>                  what is being done  (see ./capabilities)
 *   kh:<type>/<id>[/<type>/<id>...]    what it is done to  (this file)
 *
 * The canonical form for an onchain call is:
 *
 *   kh:chain/8453/contract/0xa238.../fn/0x617ba037
 *
 * Functions are identified by SELECTOR, never by signature. The selector is what
 * is actually on the wire; the signing-time check holds only {to, data, value}
 * with no ABI, so it can key on nothing else. Signature strings are also
 * ambiguous across parameter names, tuple expansion and whitespace, and every
 * normalization difference is a rule that silently stops matching. A signature
 * is an authoring and display form, converted to a selector when a policy is
 * compiled.
 *
 * Attributes are conditions, never path segments. `kh:workflow/*` plus a
 * `workflowTag` condition, not `kh:workflow/*\/tag/production`, so the path stays
 * a pure containment hierarchy and `**` keeps a single meaning.
 */

/** Namespace prefixes. */
export const ARN_PREFIX = {
  RESOURCE: "kh",
  CAPABILITY: "cap",
} as const;

export const ARN_SEGMENT_SEPARATOR = "/" as const;
export const ARN_PREFIX_SEPARATOR = ":" as const;

/** Matches exactly one segment. */
export const ARN_WILDCARD_SEGMENT = "*" as const;
/** Matches any number of remaining segments, including zero. */
export const ARN_WILDCARD_DEEP = "**" as const;

/**
 * Sentinel for a call carrying no calldata, such as a bare native transfer.
 * Leaving that case undefined is a gap rather than a sensible default.
 */
export const ARN_SELECTOR_NONE = "none" as const;

/** Segment types that may appear in a resource identifier. */
export const ArnSegment = {
  // Concrete, onchain
  CHAIN: "chain",
  CONTRACT: "contract",
  FUNCTION: "fn",
  ASSET: "asset",
  // Abstract, resolved through the ontology to concrete identifiers
  PROTOCOL: "protocol",
  PROTOCOL_CATEGORY: "protocolCategory",
  CLASS: "class",
  COUNTERPARTY: "counterparty",
  ADDRESSBOOK: "addressbook",
  // Control plane
  WORKFLOW: "workflow",
  INTEGRATION: "integration",
  WALLET: "wallet",
  MEMBER: "member",
  APIKEY: "apikey",
  POLICY: "policy",
  PROJECT: "project",
} as const;

export type ArnSegment = (typeof ArnSegment)[keyof typeof ArnSegment];

const ARN_SEGMENT_VALUES: readonly string[] = Object.values(ArnSegment);

export function isArnSegment(value: string): value is ArnSegment {
  return ARN_SEGMENT_VALUES.includes(value);
}

/**
 * Segments that carry an address and are therefore lowercased on parse, so
 * matching at decision time is a plain string compare with no case handling.
 */
const ADDRESS_SEGMENTS: readonly ArnSegment[] = [
  ArnSegment.CONTRACT,
  ArnSegment.ASSET,
  ArnSegment.COUNTERPARTY,
  ArnSegment.WALLET,
] as const;

/** One `<type>/<id>` pair. */
export type ArnPart = {
  type: ArnSegment;
  id: string;
};

export type ParsedArn = {
  parts: readonly ArnPart[];
  /** The original string, normalized. */
  value: string;
};

export type ArnParseResult =
  | { ok: true; arn: ParsedArn }
  | { ok: false; error: string };

/**
 * Accepts either case, because the parser lowercases a selector rather than
 * rejecting it. A validator stricter than the parser would refuse an
 * identifier the grammar itself accepts.
 */
const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;
const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** Base58 as Solana writes it: no 0, O, I or l, and 32 to 44 characters. */
const BASE58_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function normalizeId(type: ArnSegment, raw: string): string {
  if (raw === ARN_WILDCARD_SEGMENT || raw === ARN_WILDCARD_DEEP) {
    return raw;
  }
  if (ADDRESS_SEGMENTS.includes(type)) {
    // Only an EVM address is case-insensitive. A base58 address carries no
    // checksum, so lowercasing one does not fail, it decodes to a different
    // and still valid key: the rule would then be about a program nobody
    // named. Anything not 0x-prefixed keeps the case it was written with.
    return isHexAddress(raw) ? raw.toLowerCase() : raw;
  }
  if (type === ArnSegment.FUNCTION) {
    return raw === ARN_SELECTOR_NONE ? raw : raw.toLowerCase();
  }
  return raw;
}

/**
 * Parse and normalize a resource identifier. Returns a discriminated result
 * rather than throwing, so a malformed policy surfaces as a compile error the
 * author can act on rather than an exception at evaluation time.
 */
export function parseArn(value: string): ArnParseResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Identifier is empty" };
  }

  const prefixIdx = trimmed.indexOf(ARN_PREFIX_SEPARATOR);
  if (prefixIdx === -1) {
    return {
      ok: false,
      error: `Identifier must start with "${ARN_PREFIX.RESOURCE}${ARN_PREFIX_SEPARATOR}"`,
    };
  }

  const prefix = trimmed.slice(0, prefixIdx);
  if (prefix !== ARN_PREFIX.RESOURCE) {
    return {
      ok: false,
      error: `Unknown identifier prefix "${prefix}", expected "${ARN_PREFIX.RESOURCE}"`,
    };
  }

  const body = trimmed.slice(prefixIdx + 1);
  const segments = body.split(ARN_SEGMENT_SEPARATOR);

  // A trailing "**" stands alone rather than pairing with a type.
  const hasDeepTail = segments.at(-1) === ARN_WILDCARD_DEEP;
  const paired = hasDeepTail ? segments.slice(0, -1) : segments;

  if (paired.length % 2 !== 0) {
    return {
      ok: false,
      error: `Identifier must be <type>/<id> pairs, optionally ending in "${ARN_WILDCARD_DEEP}"`,
    };
  }

  const parts: ArnPart[] = [];
  for (let i = 0; i < paired.length; i += 2) {
    const type = paired[i];
    const id = paired[i + 1];
    if (!(type && id)) {
      return { ok: false, error: "Identifier contains an empty segment" };
    }
    if (!isArnSegment(type)) {
      return { ok: false, error: `Unknown segment type "${type}"` };
    }
    parts.push({ type, id: normalizeId(type, id) });
  }

  if (hasDeepTail) {
    parts.push({
      type: ArnSegment.CHAIN,
      id: ARN_WILDCARD_DEEP,
    });
  }

  const normalized = buildArn(
    hasDeepTail ? parts.slice(0, -1) : parts,
    hasDeepTail
  );

  return { ok: true, arn: { parts, value: normalized } };
}

/** Build a normalized identifier string from parts. */
export function buildArn(parts: readonly ArnPart[], deepTail = false): string {
  const body = parts
    .map((p) => `${p.type}${ARN_SEGMENT_SEPARATOR}${normalizeId(p.type, p.id)}`)
    .join(ARN_SEGMENT_SEPARATOR);
  const tail = deepTail ? `${ARN_SEGMENT_SEPARATOR}${ARN_WILDCARD_DEEP}` : "";
  return `${ARN_PREFIX.RESOURCE}${ARN_PREFIX_SEPARATOR}${body}${tail}`;
}

/** Convenience builder for the canonical onchain call form. */
export function buildContractCallArn(input: {
  chainId: number;
  contractAddress: string;
  selector: string | null;
}): string {
  return buildArn([
    { type: ArnSegment.CHAIN, id: String(input.chainId) },
    { type: ArnSegment.CONTRACT, id: input.contractAddress },
    { type: ArnSegment.FUNCTION, id: input.selector ?? ARN_SELECTOR_NONE },
  ]);
}

export function buildAssetArn(input: {
  chainId: number;
  tokenAddress: string;
}): string {
  return buildArn([
    { type: ArnSegment.CHAIN, id: String(input.chainId) },
    { type: ArnSegment.ASSET, id: input.tokenAddress },
  ]);
}

/** Control-plane resources are flat: one type, one id. */
export function buildResourceArn(type: ArnSegment, id: string): string {
  return buildArn([{ type, id }]);
}

export function isValidSelector(value: string): boolean {
  return value === ARN_SELECTOR_NONE || SELECTOR_PATTERN.test(value);
}

/** An EVM address: 0x and twenty bytes, case-insensitive. */
function isHexAddress(value: string): boolean {
  return HEX_ADDRESS_PATTERN.test(value);
}

/**
 * An address the grammar can hold.
 *
 * Two families, deliberately kept apart. An EVM address is hex and compared
 * case-insensitively; a base58 address is compared exactly, because case is
 * part of the key rather than presentation.
 */
export function isValidAddress(value: string): boolean {
  return isHexAddress(value) || BASE58_ADDRESS_PATTERN.test(value);
}

/**
 * True when `pattern` covers `target`.
 *
 * Both are parsed identifiers. A pattern segment matches when its type is equal
 * and its id is equal, `*`, or the pattern ends in `**` at that depth.
 *
 * A pattern with fewer parts than the target only matches when it ends in `**`;
 * otherwise `kh:chain/8453` does not cover
 * `kh:chain/8453/contract/0xabc.../fn/0x11223344`, which keeps the containment
 * hierarchy honest.
 */
export function arnMatches(pattern: ParsedArn, target: ParsedArn): boolean {
  const patternParts = pattern.parts;
  const deep = patternParts.at(-1)?.id === ARN_WILDCARD_DEEP;
  const comparable = deep ? patternParts.slice(0, -1) : patternParts;

  if (!deep && comparable.length !== target.parts.length) {
    return false;
  }
  if (comparable.length > target.parts.length) {
    return false;
  }

  for (const [i, patternPart] of comparable.entries()) {
    const targetPart = target.parts[i];
    if (!targetPart) {
      return false;
    }
    if (patternPart.type !== targetPart.type) {
      return false;
    }
    if (patternPart.id === ARN_WILDCARD_SEGMENT) {
      continue;
    }
    if (patternPart.id !== targetPart.id) {
      return false;
    }
  }

  return true;
}

/** String-level convenience wrapper. Invalid identifiers never match. */
export function arnStringMatches(pattern: string, target: string): boolean {
  const p = parseArn(pattern);
  const t = parseArn(target);
  if (!(p.ok && t.ok)) {
    return false;
  }
  return arnMatches(p.arn, t.arn);
}

/**
 * True when an identifier names concrete onchain state rather than an ontology
 * class. Concrete identifiers are what a decision is evaluated against;
 * abstract ones are expanded to concrete ones when a policy is compiled.
 */
export function isConcreteArn(arn: ParsedArn): boolean {
  const abstractTypes: readonly ArnSegment[] = [
    ArnSegment.PROTOCOL,
    ArnSegment.PROTOCOL_CATEGORY,
    ArnSegment.CLASS,
    ArnSegment.ADDRESSBOOK,
  ];
  return !arn.parts.some((p) => abstractTypes.includes(p.type));
}
