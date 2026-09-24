/**
 * Client-side bookkeeping for the paginated executions list: the runs panel
 * keeps every page it has loaded and re-fetches only the first one while
 * polling, so these fold a fresh page into what is already on screen.
 *
 * Every page names the workflow it belongs to. A response for the previous
 * workflow that lands after the panel switched must not be shown under the
 * new one, so each helper drops a page whose workflow is not the loaded
 * page's.
 */
export type ExecutionPage<T> = {
  workflowId: string | null;
  executions: T[];
  nextCursor: string | null;
  total: number;
};

export function emptyExecutionPage(
  workflowId: string | null
): ExecutionPage<never> {
  return { workflowId, executions: [], nextCursor: null, total: 0 };
}

/** A full load: the page replaces the list, unless it is another workflow's. */
export function replacePage<T extends { id: string }>(
  loaded: ExecutionPage<T>,
  page: ExecutionPage<T>
): ExecutionPage<T> {
  return page.workflowId === loaded.workflowId ? page : loaded;
}

/**
 * Fold a freshly fetched first page into the loaded list.
 *
 * Rows the page covers replace their loaded counterparts (status and progress
 * move on while a run is in flight) and rows new since the last fetch land at
 * the top. Rows the page no longer covers are kept in place: they are the older
 * pages the viewer has loaded, plus whatever the newest runs pushed past the
 * first-page boundary. The stored cursor still points at the tail of that
 * retained list, so it survives; only when nothing was retained is the page's
 * own cursor the tail.
 *
 * A page without a `nextCursor` is the complete list, so nothing outside it is
 * kept. That is what empties the panel after the runs are purged.
 */
export function mergeFirstPage<T extends { id: string }>(
  loaded: ExecutionPage<T>,
  page: ExecutionPage<T>
): ExecutionPage<T> {
  if (page.workflowId !== loaded.workflowId) {
    return loaded;
  }
  if (page.nextCursor === null) {
    return page;
  }
  const covered = new Set(page.executions.map((execution) => execution.id));
  const retained = loaded.executions.filter(
    (execution) => !covered.has(execution.id)
  );
  return {
    workflowId: page.workflowId,
    executions: [...page.executions, ...retained],
    nextCursor: retained.length > 0 ? loaded.nextCursor : page.nextCursor,
    total: page.total,
  };
}

/**
 * How many runs the next cursor fetch will return: the runs not yet on
 * screen, at most one page. A poll that prepends a new run raises the total
 * and the loaded count together, so the number holds steady; it is 0 once
 * everything is loaded, or when a purge leaves fewer runs than are shown.
 */
export function nextPageSize(
  total: number,
  loadedCount: number,
  pageSize: number
): number {
  return Math.max(0, Math.min(total - loadedCount, pageSize));
}

/** Append an older page fetched with the stored cursor. */
export function appendPage<T extends { id: string }>(
  loaded: ExecutionPage<T>,
  page: ExecutionPage<T>
): ExecutionPage<T> {
  if (page.workflowId !== loaded.workflowId) {
    return loaded;
  }
  const seen = new Set(loaded.executions.map((execution) => execution.id));
  const fresh = page.executions.filter((execution) => !seen.has(execution.id));
  return {
    workflowId: page.workflowId,
    executions: [...loaded.executions, ...fresh],
    nextCursor: page.nextCursor,
    total: page.total,
  };
}
