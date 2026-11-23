/** The slug a Hub public tag gets from its name, e.g. "Cross-chain Bridges" -> "cross-chain-bridges". */
export function publicTagSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
