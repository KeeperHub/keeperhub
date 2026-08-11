/**
 * Shared offset-based, HATEOAS pagination for list endpoints.
 *
 * Endpoints accept `?page=` (1-based) and `?limit=` (page size), run a COUNT
 * plus an OFFSET/LIMIT slice, then return `items`, `meta` (total, page,
 * pageSize, totalPages), and `_links` (self/first/prev/next/last). This gives
 * the client everything a numbered pager needs (< 1 2 3 ... >) plus links to
 * follow. Offset paging is the right fit when total count and arbitrary page
 * jumps matter; for append-only infinite scroll a cursor would be cheaper.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type PageLinks = {
  self: string;
  first: string;
  prev: string | null;
  next: string | null;
  last: string;
};

export type PageMeta = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type Page<T> = {
  items: T[];
  meta: PageMeta;
  _links: PageLinks;
};

export type PageRequest = {
  page: number;
  pageSize: number;
  offset: number;
};

/** Clamp a raw `?limit=` value into [1, max], falling back when absent/invalid. */
export function parsePageLimit(
  raw: string | null,
  opts?: { fallback?: number; max?: number }
): number {
  const fallback = opts?.fallback ?? DEFAULT_PAGE_SIZE;
  const max = opts?.max ?? MAX_PAGE_SIZE;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 1), max);
}

/** Parse `?page=` (1-based) and `?limit=` into a page request with offset. */
export function parsePageRequest(
  url: URL,
  opts?: { fallback?: number; max?: number }
): PageRequest {
  const pageSize = parsePageLimit(url.searchParams.get("limit"), opts);
  const parsedPage = Number.parseInt(url.searchParams.get("page") ?? "", 10);
  const page = Number.isNaN(parsedPage) ? 1 : Math.max(1, parsedPage);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pageHref(url: URL, page: number, pageSize: number): string {
  const params = new URLSearchParams(url.search);
  params.set("page", String(page));
  params.set("limit", String(pageSize));
  return `${url.pathname}?${params.toString()}`;
}

/**
 * Assemble a page response from the sliced `items` and the `total` row count.
 * `page` is clamped against the real total so an out-of-range request still
 * returns coherent links.
 */
export function buildPage<T>(
  items: T[],
  total: number,
  req: PageRequest,
  url: URL
): Page<T> {
  const totalPages = Math.max(1, Math.ceil(total / req.pageSize));
  const page = Math.min(req.page, totalPages);
  return {
    items,
    meta: { total, page, pageSize: req.pageSize, totalPages },
    _links: {
      self: pageHref(url, page, req.pageSize),
      first: pageHref(url, 1, req.pageSize),
      prev: page > 1 ? pageHref(url, page - 1, req.pageSize) : null,
      next: page < totalPages ? pageHref(url, page + 1, req.pageSize) : null,
      last: pageHref(url, totalPages, req.pageSize),
    },
  };
}
