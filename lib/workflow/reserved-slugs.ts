/**
 * Reserved slugs that must NOT be used as workflow `listedSlug` values OR
 * public-tag `slug` values, because they collide with reserved Next.js path
 * segments under /hub/tags/[tag] (HUB-11).
 *
 * Existing rows that collide are flagged in a one-time migration log; this
 * module enforces the rule for all NEW writes only.
 */
export const RESERVED_SLUGS = [
  "tags",
  "protocol",
  "marketplace",
  "auth",
  "api",
  "admin",
  "_next",
  "og",
  "well-known",
] as const satisfies readonly string[];

export type ReservedSlug = (typeof RESERVED_SLUGS)[number];

/**
 * Returns true if `slug` (case-insensitive) is in `RESERVED_SLUGS`.
 * Empty string returns false.
 */
export function isReservedSlug(slug: string): boolean {
  if (!slug) {
    return false;
  }
  const lower = slug.toLowerCase();
  return (RESERVED_SLUGS as readonly string[]).includes(lower);
}
