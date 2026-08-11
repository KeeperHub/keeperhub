/**
 * Typed re-exports of the SSRF blocklist data in `lib/ssrf-blocklist.json`.
 *
 * The underlying data lives in a JSON file (not this `.ts` file) for a
 * specific reason: two consumers need to read it, and they have
 * incompatible module-resolution conventions for `.ts`/`.js` files.
 *
 *   1. `lib/safe-fetch.ts` and `lib/db/connection-host-guard.ts` are
 *      bundled by Next.js Turbopack and want extension-less imports.
 *   2. `lib/sandbox/child-source.ts` is also compiled by the standalone
 *      `@keeperhub/sandbox` package (separate tsconfig) and runs under
 *      strict ESM in a `"type": "module"` Node process, which requires
 *      explicit file extensions in import specifiers.
 *
 * A `.json` extension resolves identically in both contexts, so the
 * data lives there. This `.ts` file is a thin typed wrapper used only
 * by the keeperhub-side consumers; the sandbox `child-source.ts`
 * imports the JSON directly without going through this wrapper.
 *
 * Adding a new range: edit `lib/ssrf-blocklist.json`. Both consumers
 * pick it up automatically.
 *
 * Note: `nat64PrefixCidr` (64:ff9b::/96) is intentionally NOT in
 * `ipv6Cidrs`. In dual-stack networks resolvers synthesise this prefix
 * for every IPv4-only public host; blanket-blocking would block
 * legitimate destinations. Consumers handle this prefix specially by
 * extracting the embedded IPv4 and rechecking it against the IPv4
 * list. Site-local NAT64 (64:ff9b:1::/48, RFC 8215) IS in `ipv6Cidrs`
 * because by-construction the embedded IPv4 maps to internal infra.
 */

import data from "./ssrf-blocklist.json" with { type: "json" };

export type Cidr = readonly [address: string, prefix: number];

// The cast goes via `unknown` because JSON arrays-of-tuples widen to
// `(string | number)[][]` at parse time, which TS deems too broad for a
// direct `Cidr[]` assertion. The JSON schema is documented at the top of
// `lib/ssrf-blocklist.json`; entries must be `[address: string, prefix:
// number]` pairs by convention.
export const SSRF_IPV4_CIDRS: readonly Cidr[] =
  data.ipv4Cidrs as unknown as Cidr[];

export const SSRF_IPV4_BROADCAST_ADDRESSES: readonly string[] =
  data.ipv4BroadcastAddresses;

export const SSRF_IPV6_CIDRS: readonly Cidr[] =
  data.ipv6Cidrs as unknown as Cidr[];

export const SSRF_IPV6_LITERAL_ADDRESSES: readonly string[] =
  data.ipv6LiteralAddresses;

export const SSRF_NAT64_PREFIX_CIDR: Cidr =
  data.nat64PrefixCidr as unknown as Cidr;

export const SSRF_BLOCKED_HOST_EXACT: readonly string[] = data.blockedHostExact;

export const SSRF_BLOCKED_HOST_SUFFIXES: readonly string[] =
  data.blockedHostSuffixes;
