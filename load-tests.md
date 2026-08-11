# k6 Load Test Results — Production-Realistic Execution Test

**Date:** 2026-03-25
**Target:** PR-663 environment (`app-pr-663.keeperhub.com`)
**Cluster:** techops-staging EKS (us-east-1), namespace `pr-663`
**Infrastructure:** Single app pod, CNPG PostgreSQL 16, Redis, LocalStack (SQS), scheduler-dispatcher + scheduler-executor

## Test Design

Replicates the real production workload: scheduled workflows triggered by the actual scheduler service.

**Setup per VU:**
1. Sign up, verify email (OTP), sign in
2. Create N workflows with realistic patterns (75% Schedule, 25% Manual)
3. Enable workflows via admin endpoint (creates `workflow_schedules` records)

**Execution — real scheduler path:**
- `scheduler-dispatcher` polls `/api/internal/schedules` every 60 seconds
- Evaluates cron expressions, enqueues matching workflows to SQS
- `scheduler-executor` polls SQS, calls `POST /api/workflow/{id}/execute`
- Manual workflows triggered by k6 via an HMAC-signed internal request every 60 seconds

**Observation:** 3-minute window per tier, then collect execution results from API.

**Workflow patterns (10 templates):**
- 7 Schedule + 3 Manual (matching production's ~95/5 distribution)
- 2-7 nodes each: HTTP Request, Condition, branching, parallel reads, sequential pipelines
- All actions mock external services via `/api/health` (isolates execution engine from third-party latency)

## Results — Gradual Buildup (Finding the Breaking Point)

20 VUs, workflows added incrementally per tier, 3-minute observation windows.

| Tier (wf/VU) | Total Workflows | Executions | Success | Error | Success Rate | Status |
|-------------|----------------|------------|---------|-------|-------------|--------|
| 10 | 200 | 735 | 735 | 0 | **100%** | PASS |
| 12 | 240 | 880 | 880 | 0 | **100%** | PASS |
| 14 | 280 | 1,035 | 609 | 426 | **58.8%** | FAIL |

## Results — Starting at 20 wf/VU (Cold Start)

20 VUs, all 20 workflows created at once per VU.

| Tier (wf/VU) | Total Workflows | Executions | Success | Error | Success Rate | Status |
|-------------|----------------|------------|---------|-------|-------------|--------|
| 20 | 400 | 1,375 | 822 | 553 | **59.8%** | FAIL |

## Capacity Summary

**Single-pod PR environment can sustain 240 active scheduled workflows (20 users x 12 each) at 100% execution success rate.**

At 280 workflows (14/VU), success rate drops to 58.8%. The degradation is sharp — not a gradual decline but a cliff between 240 and 280 concurrent workflows.

## Bottleneck Analysis

The scheduler dispatches all workflows every 60 seconds. At 240 workflows, the app processes them all within the minute. At 280+, executions start queuing up, overlapping with the next dispatch cycle, causing timeouts and errors.

Key factors:
- **Node.js single-thread**: Workflow execution runs inline in the API process
- **DB connection pool (max 10)**: Each execution does multiple DB operations
- **Concurrent execution limit**: `checkConcurrencyLimit()` may reject workflows when too many are already running

## Recommendations

1. **Horizontal scaling**: 2 pods should roughly double capacity to ~500 workflows
2. **Increase DB pool**: Raise from 10 to 25+ connections
3. **Async execution**: Dispatch to K8s Jobs via SQS instead of inline execution
4. **Production test**: Run against staging (same infra but real RDS) after merge

## Test Infrastructure

| Component | Configuration |
|-----------|--------------|
| App | 1 pod, KeeperHub Next.js (Node.js 22) |
| Database | CNPG PostgreSQL 16 (PR-isolated) |
| Redis | 1 pod |
| SQS | LocalStack |
| Scheduler | dispatcher + executor (1 pod each) |
| Test tool | k6 v0.56.0, run from local machine via CF Access headers |
| Auth | k6 signs up/verifies/signs in; enables via admin endpoint; scheduler triggers via SQS |

## Cleanup

All tests cleaned via `POST /api/admin/test/cleanup` API endpoint. Verified zero test records remaining after each run.
