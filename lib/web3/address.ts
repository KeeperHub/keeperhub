/**
 * EVM address primitives, with no dependencies so any bundle can pull them in.
 *
 * ZERO_ADDRESS previously lived in lib/safe/address.ts, which imports ethers,
 * so the four callers that only wanted the literal were re-typing it instead:
 * the string appeared thirty-seven times in production code.
 *
 * EVM_ADDRESS_RE replaces fourteen private copies of the same regex under
 * eleven names, in two byte-variants that differ only in the order of the hex
 * character class. It is a shape check, not a checksum check: it accepts
 * all-lowercase and all-uppercase addresses exactly as every copy it replaces
 * did. Switching to a checksum-validating test (viem's isAddress) is a
 * behaviour change per call site and is deliberately left alone here.
 */

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
