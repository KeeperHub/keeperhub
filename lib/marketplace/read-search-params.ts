// Pure helpers for reading marketplace `searchParams` values. Kept in a
// dependency-free module so they can be unit-tested without dragging in
// drizzle/db imports from the RSC tab module.

// Cap reader-side string length to prevent unstable_cache key pollution
// via random `?q=` / `?owner=` spam — each distinct cache key triggers a
// fresh DB hit before the data cache.
export const MAX_QUERY_LENGTH = 100;

export function readQueryParam(value: string | string[] | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, MAX_QUERY_LENGTH);
}

// Owner filter (?owner=<organization-name>). Matches readQuery's bound
// and collapses empty-after-trim to null so the query path skips the
// filter cleanly.
export function readOwnerParam(
  value: string | string[] | undefined
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().slice(0, MAX_QUERY_LENGTH);
  return trimmed === "" ? null : trimmed;
}
