# Analytics Dashboard Specification

## Overview

Org-scoped analytics dashboard providing real-time execution monitoring, gas spend tracking, and success rate analysis across both workflow and direct executions.

## Requirements

| ID | Requirement | Priority |
|----|------------|----------|
| ANALYTICS-01 | Unified runs view (workflow_executions + direct_executions) | P0 |
| ANALYTICS-02 | Real-time updates via SSE with polling fallback | P0 |
| ANALYTICS-03 | Gas analytics (spend by network, spend cap usage) | P1 |
| ANALYTICS-04 | Execution timeline chart (stacked by status, time-bucketed) | P0 |
| ANALYTICS-05 | KPI summary cards (total runs, success %, avg duration, gas spent) | P0 |
| ANALYTICS-06 | Org-scoped data (all queries filtered by organizationId) | P0 |
| ANALYTICS-07 | Per-workflow drill-down (click row to navigate to workflow) | P1 |
| ANALYTICS-08 | Step-level breakdown (expandable rows with node logs) | P1 |
| ANALYTICS-09 | Date range filtering (1h, 24h, 7d, 30d, custom) | P0 |
| ANALYTICS-10 | Comparison deltas (vs previous period) on KPI cards | P2 |

## Unified Run Type

Normalizes `workflow_executions` and `direct_executions` into a single shape:

- `id`, `source` ("workflow" | "direct"), `status`, `startedAt`, `completedAt`, `durationMs`
- `workflowId`, `workflowName` (null for direct)
- `directType` ("transfer" | "contract-call" | "check-and-execute", null for workflow)
- `network`, `transactionHash`, `gasUsedWei` (web3 fields)
- `totalSteps`, `completedSteps` (workflow progress fields)

## Data Sources

| UI Element | DB Table | Join/Filter |
|-----------|----------|-------------|
| Workflow runs | `workflow_executions` | JOIN `workflows` ON `organizationId` |
| Direct runs | `direct_executions` | Direct `organizationId` column |
| Gas totals | `direct_executions` | SUM(`gasUsedWei`) by network |
| Spend cap | `organization_spend_caps` | Per org, compare to daily SUM |
| Step logs | `workflow_execution_logs` | By `executionId` |
| Pending txs | `pending_transactions` | By `executionId` |

## API Routes

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/analytics/summary?range=24h` | `AnalyticsSummary` |
| GET | `/api/analytics/time-series?range=24h` | `{ buckets: TimeSeriesBucket[] }` |
| GET | `/api/analytics/networks?range=24h` | `{ networks: NetworkBreakdown[] }` |
| GET | `/api/analytics/runs?range=24h&cursor=X&limit=50&status=error&source=workflow` | `{ runs: UnifiedRun[], nextCursor }` |
| GET | `/api/analytics/stream?range=24h` | SSE stream |

## Page Layout

```
[Date Range: 1h | 24h | 7d | 30d | custom]  [Live indicator]
[Total Runs] [Success %] [Avg Duration] [Gas Spent]     <- KPI cards
[Execution Timeline - stacked area chart by status]      <- Primary chart
[Gas by Network - bar chart] | [Error Rate - line chart] <- Side-by-side
[Unified Runs Table - filterable, paginated, expandable] <- Main table
[Top Workflows - ranked] | [Spend Cap - progress bar]   <- Bottom row
```

## SSE Design

- Server polls DB every 2s, computes lightweight checksum (MAX timestamps + active count)
- Only sends data when checksum changes, throttled to max 1 event/sec
- 5-minute max lifetime, client auto-reconnects via EventSource
- Fallback: client polls REST endpoints at 10s intervals if SSE disconnects

## Edge Cases

- 100K+ executions: cursor-based pagination, server-side aggregation only
- Null gasUsedWei: exclude from SUM/AVG, show "N/A" in table
- Empty org: show empty state with CTA to create first workflow
- SSE disconnect: auto-reconnect + polling fallback + "Last updated" timestamp
- Deleted workflows: show "(Deleted)" label, still include in stats
- Org isolation: every query includes organizationId WHERE clause
- Mobile: stack cards vertically, horizontal scroll on table

## Decisions

- D-029: Chart library = recharts (shadcn/ui recommended, Trigger.dev uses it)
- D-030: SSE with polling fallback for real-time
- D-031: Query existing tables only (no new analytics tables)
- Single scrollable page (not tabs) for cross-referencing
