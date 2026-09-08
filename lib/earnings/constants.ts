/**
 * Default page size for the Workflow Earnings table.
 *
 * Shared by:
 *   - app/api/earnings/route.ts (server default when no pageSize query param)
 *   - components/earnings/use-earnings.ts (client fetch parameter)
 *   - components/earnings/workflow-earnings-table.tsx (UI fallback when the
 *     API response omits pageSize)
 *
 * Keeping these in sync prevents pagination math drift between the page-size
 * value the client requests and the value the UI assumes when rendering
 * "X-Y of N" and computing totalPages.
 */
export const EARNINGS_PAGE_SIZE = 20;
