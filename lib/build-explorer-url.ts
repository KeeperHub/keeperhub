/**
 * Block explorer URL helpers.
 * Client-safe; the pure join is shared with the server builders in
 * @/lib/explorer so both produce identical URLs.
 */

/**
 * Join an explorer base URL with a path, preserving any query string on the
 * base (e.g. Solana devnet's `?cluster=devnet`) and any `#fragment` on the
 * path. Naive concatenation (`base + path`) puts the path after the query
 * string, producing a malformed URL for chains whose base carries a query.
 *
 *   https://solscan.io/?cluster=devnet  +  /tx/{hash}
 *     -> https://solscan.io/tx/<hash>?cluster=devnet
 */
export function joinExplorerUrl(explorerUrl: string, path: string): string {
  const [base, ...queryParts] = explorerUrl.split("?");
  const query = queryParts.join("?");
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;

  // The query must sit before any fragment carried by the path.
  const [pathPart, ...fragmentParts] = path.split("#");
  const fragment = fragmentParts.join("#");

  let url = `${cleanBase}${pathPart}`;
  if (query) {
    url += `?${query}`;
  }
  if (fragment) {
    url += `#${fragment}`;
  }
  return url;
}

/**
 * Build block explorer URL for an address.
 * Client-safe; mirrors logic from @/lib/explorer getAddressUrl.
 */
export function buildAddressUrl(
  explorerUrl: string | null,
  explorerAddressPath: string | null,
  address: string
): string | null {
  if (!(explorerUrl && explorerAddressPath)) {
    return null;
  }
  return joinExplorerUrl(
    explorerUrl,
    explorerAddressPath.replace("{address}", address)
  );
}
