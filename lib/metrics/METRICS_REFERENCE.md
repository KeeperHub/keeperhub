# KeeperHub Metrics Reference

Golden signal metrics for application-level observability.

---

## Data Sources

Metrics are collected from two sources depending on the collector type:

| Source | Description | Metrics |
|--------|-------------|---------|
| **Database** | Queried from PostgreSQL on each Prometheus scrape. Required because workflow runner jobs exit before Prometheus can scrape them. | Workflow executions, steps, queue depth, concurrent count, daily active users, user stats, organization stats, workflow definitions, schedules, integrations, infrastructure |
| **API Process** | Recorded in-memory during request handling. Works normally as the API process is long-running. | Webhook latency, status polling latency, AI generation duration, plugin action duration/errors/invocations |

### Collector Behavior

| Collector | DB-sourced metrics | API-process metrics |
|-----------|-------------------|---------------------|
| **Prometheus** | Queried fresh on each `/api/metrics` scrape | Accumulated in-memory, scraped with other metrics |
| **Console** | Not emitted (would require separate cron) | Logged as structured JSON on each event |

> **Note:** DB-sourced duration metrics (workflow/step) are exposed as Prometheus gauges with `_bucket/_sum/_count` suffixes to simulate histogram semantics. Standard `histogram_quantile()` queries work, but `# TYPE` will show `gauge` instead of `histogram`.

> **Note:** All DB-sourced metrics are gauges (point-in-time snapshots). Use `max()` aggregation in multi-pod deployments. For rate/delta queries, use PromQL's `delta()` function on gauges. See "Using delta() for Rate Queries" section.

> **Note:** Runtime code (executor, routes) also increments workflow metrics for console logging, but Prometheus relies solely on DB snapshots. This dual approach ensures complete data even when workflow runners exit before scrape.

> **Note (TECH-6484):** The DB-sourced gauges are served by the dedicated single-replica `keeperhub-metrics-collector` service (`deploy/metrics-collector/`), not by the app pods. It reuses this module's `updateDbMetrics` / `getDbMetrics` and serves them on `/metrics`. Its ServiceMonitor scrapes the gauges deterministically from one pod. The app's `/api/metrics/db` route is gated off via `METRICS_DB_OFFLOADED` and its `db-metrics` ServiceMonitor removed, so the heavy aggregate scan no longer runs on the request-serving pods. `/api/metrics/api` (per-pod, in-memory) is unchanged.

---

## Architecture Context

Understanding the user/org/wallet model helps interpret metrics correctly:

| Entity | Description | Expected Relationships |
|--------|-------------|------------------------|
| **User** | Registered or anonymous account | Each registered user auto-gets a personal org |
| **Organization** | Multi-tenant container for workflows/credentials | Each org auto-gets a Turnkey wallet |
| **Wallet** | Turnkey-backed signer for blockchain operations | 1:1 with organizations |
| **Anonymous User** | Trial user without org | Can run workflows, but no chain operations |

**Key metric relationships:**
- `org.total` ≈ `wallet.total` (1:1 org-to-wallet)
- `user.total` ≥ `org.total` (users can share orgs via invites)
- `user.anonymous` = users without orgs (trial mode)
- Web3 steps (`transfer-funds`, `write-contract`) require org + wallet

---

## 1. LATENCY (Response Time)

Histogram metrics tracking duration/response times.

| Metric Name | Description | Labels | Target | Source |
|-------------|-------------|--------|--------|--------|
| `workflow.execution.duration_ms` | Total workflow execution time | `le` (bucket) | P95 < 2000ms | DB |
| `workflow.step.duration_ms` | Individual step execution time | `le` (bucket) | P95 < 500ms | DB |
| `api.webhook.latency_ms` | Webhook trigger response time | `status_code`, `status` | P95 < 50ms | API |
| `api.status.latency_ms` | Status polling response time | `status_code`, `status`, `execution_status` | P95 < 30ms | API |
| `plugin.action.duration_ms` | Plugin action execution time | `plugin_name`, `action_name`, `status` | P95 < 1000ms | API |
| `ai.generation.duration_ms` | AI workflow generation time | `status` | P95 < 5000ms | API |

---

## 2. TRAFFIC (Request Rate)

Counter/Gauge metrics tracking request/event counts.

| Metric Name | Description | Labels | Unit | Source |
|-------------|-------------|--------|------|--------|
| `workflow.executions.total` | Total workflow executions by status (all-time) | `status`, `org_slug`, `error_type` (`user`/`system`/`unknown`/`na`) | gauge | DB |
| `workflow.execution.errors.total` | Total failed workflow executions (all-time) | - | gauge | DB |
| `plugin.invocations.total` | Plugin action invocations | `plugin_name`, `action_name` | count | API |
| `user.active.daily` | Daily active users (24h) | - | gauge | DB |

### Scan Funnel Metrics (scan-to-automate landing)

Per-pod counters in `apiRegistry`, scraped from `/api/metrics/api`. Usage and
conversion signals for the anonymous scan landing page.

| Metric Name | Description | Labels | Unit | Source |
|-------------|-------------|--------|------|--------|
| `keeperhub_scan_requests_total` | Scan API requests by outcome (`success` = suggestions returned, `empty` = scan ran but produced none, `failure`, `rate_limited`, `invalid_query`, `ens_unresolved`) | `status` | count | API |
| `keeperhub_scan_cache_lookups_total` | Scan result cache lookups; `miss` approximates unique addresses per 5-min TTL window | `result` (`hit`/`miss`) | count | API |
| `keeperhub_scan_intents_total` | Anonymous funnel round-trip: `created` = pre-auth "Use this workflow" click, `consumed` = post-auth resume; consumed/created is the anon-to-signup conversion rate | `stage` | count | API |
| `keeperhub_workflows_created_total` | Workflows created via the create API by originating surface; scan persists send `x-keeperhub-source`, unrecognised values coerce to `other` | `source` (`scan-run`/`scan-schedule`/`other`) | count | API |

---

## 3. ERRORS (Error Rate)

Error metrics tracking failures and exceptions.

| Metric Name | Description | Labels | Target | Source |
|-------------|-------------|--------|--------|--------|
| `workflow.execution.errors` | Failed workflow executions | - | < 5% | DB |
| `workflow.errors.by_workflow` | Errored executions in the **last hour** (rolling 1h window), managed orgs only. Powers the Sky/Ajna managed-client error alerts; the alert reads it directly (no offset). Not cumulative. | `workflow_id`, `org_slug`, `error_type` | - | DB |
| `workflow.step.errors` | Failed step executions | `step_type` | < 10% | DB |
| `plugin.action.errors` | Failed plugin actions | `plugin_name`, `action_name`, `error_type` | < 20% | API |
| `api.errors.total` | API errors (webhook failures) | `endpoint`, `status_code`, `error_type` | count | API |

---

## 4. SATURATION (Resource Utilization)

Gauge metrics tracking resource usage and capacity.

| Metric Name | Description | Labels | Threshold | Source |
|-------------|-------------|--------|-----------|--------|
| `workflow.queue.depth` | Pending workflow jobs | - | < 50 | DB |
| `workflow.concurrent.count` | Concurrent workflow executions | - | gauge | DB |

### Process Memory

Per-pod Node.js memory, emitted from `lib/metrics/instrumentation/process-memory.ts`. These are registered directly on the API-process registry rather than through `setGauge()`, so they appear on `/api/metrics/api` only and have no console-collector equivalent. Prometheus names are listed in full because these gauges are not routed through `MetricNames`.

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `keeperhub_process_memory_rss_bytes` | Resident set size of the process | - | API |
| `keeperhub_process_memory_heap_used_bytes` | V8 heap in use | - | API |
| `keeperhub_process_memory_external_bytes` | Memory held by C++ objects bound to JavaScript | - | API |
| `keeperhub_process_memory_array_buffers_bytes` | Memory held by ArrayBuffers and Buffers, a subset of `external` | - | API |
| `keeperhub_process_memory_*_peak_bytes` | High-water mark of the matching bucket since the previous scrape | - | API |

Alongside these, the cgroup v2 accounting for the container itself, read from `lib/metrics/cgroup-memory.ts`. These are absent off-cluster, where the files do not exist.

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `keeperhub_container_memory_current_bytes` | Current cgroup charge for the container | - | API |
| `keeperhub_container_memory_peak_bytes` | Kernel high-water mark since the container started | - | API |
| `keeperhub_container_memory_limit_bytes` | The cgroup limit, from `memory.max` | - | API |
| `keeperhub_container_memory_oom_kills` | OOM kills the kernel performed in this cgroup | - | API |

### Which one to read

**`keeperhub_container_memory_peak_bytes` answers "how close did this container get to being killed".** The kernel maintains that high-water mark continuously, so unlike everything else here it cannot miss a spike that opens and closes between two reads. `container_memory_working_set_bytes` from cadvisor can and does: it samples once per 60s, `container_memory_max_usage_bytes` is not shipped to our Mimir tenant, and prod containers have crossed the limit and died inside a single sample gap leaving nothing behind. Prefer the cgroup number over cadvisor and over `rss` - the cgroup charge is what the OOM killer compares, and it counts page cache that RSS does not.

**The `_peak_bytes` process buckets answer "which part of the process grew".** The cgroup cannot say, and that is the question when deciding whether a change is a heap problem or an off-heap one. These are sampled every second, so a spike shorter than that interval can still slip past them.

Each export of the process buckets opens a new window, so `delta()` and `rate()` are meaningless on them; graph with `max_over_time()`. The cgroup peak is monotonic for the life of the container instead, and resets on restart.

### The gap none of these close

A container killed mid-burst never reaches the scrape that would have carried its window, so **no gauge here can describe the burst that actually kills a pod** - only near misses. For that case the sampler writes a log line when the cgroup charge crosses 75% of the limit, carrying the bucket split, and re-arms once it falls below 65%. That line ships as it is written and outlives the kill. Search Loki for `[ProcessMemory]`.

`prom-client`'s default Node.js metrics are registered on the same registry, so `nodejs_gc_duration_seconds`, the per-space `nodejs_heap_space_size_*_bytes` breakdown, and `nodejs_eventloop_lag_seconds` are available alongside them.

---

## Safe Wallet Metrics

Hot-path observability for the Safe smart-account integration. Emitted from `lib/metrics/instrumentation/safe.ts` and consumed by the Grafana alerts in the infrastructure repo's `keeperhub_metrics_alerts.tf` (section: Safe Wallet Alerts).

| Metric Name | Type | Description | Labels | Fires on |
|-------------|------|-------------|--------|----------|
| `safe.deploy.total` | counter | Safe CREATE2 deploys via `SafeProxyFactory` | `chain_id`, `outcome` (`success` / `already_deployed` / `failure`) | `deployOrgSafe` |
| `safe.deploy.duration_ms` | histogram | Wall-clock duration of the deploy | same | `deployOrgSafe` |
| `safe.role_install.total` | counter | Zodiac Roles modifier proxy deploys + initial scope writes | `chain_id`, `outcome` | `installRolesWithInitialConfig` |
| `safe.role_install.duration_ms` | histogram | Wall-clock duration of the install | same | `installRolesWithInitialConfig` |
| `safe.tx.total` | counter | Safe-routed transactions (both `safe.execTransaction` and `rolesModifier.execTransactionWithRole`) | `chain_id`, `route` (`exec` / `role`), `kind` (`native` / `erc20` / `contract`), `outcome` | `executeContractCallAsSafe`, `executeNativeTransferAsSafe`, `executeContractCallAsRole`, `executeNativeTransferAsRole` |
| `safe.tx.duration_ms` | histogram | Wall-clock duration of the inner Safe write | same | same |
| `safe.withdraw.total` | counter | User-initiated Safe withdrawals (separate from workflow-driven Safe writes) | `chain_id`, `kind`, `outcome` | `/api/user/wallet/withdraw` when body carries `safeId` |

`route` distinguishes owner-signed `safe.execTransaction` (`exec`) from Zodiac Roles modifier writes (`role`); `kind` splits native value transfers from ERC-20 transfers/approvals (`erc20`) from arbitrary contract calls (`contract`). The withdraw counter intentionally overlaps with `safe.tx.*` (every withdraw is also one safe.tx) so the user-driven surface can be alerted on independently from workflow traffic.

---

## 5. USER & ORGANIZATION

Gauge metrics tracking user and organization statistics.

### User Metrics

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `user.total` | Total registered users | - | DB |
| `user.verified` | Users with verified email | - | DB |
| `user.anonymous` | Anonymous users | - | DB |
| `user.with_workflows` | Users who have created at least one workflow | - | DB |
| `user.with_integrations` | Users who have configured at least one integration | - | DB |
| `user.active.daily` | Daily active users (24h) | - | DB |
| `user.info` | Info gauge with one series per user | `email`, `name`, `verified` | DB |

### Organization Metrics

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `org.total` | Total organizations | - | DB |
| `org.members.total` | Total organization members across all orgs | - | DB |
| `org.members_by_role` | Organization members by role | `role` | DB |
| `org.invitations.pending` | Pending organization invitations | - | DB |
| `org.with_workflows` | Organizations with at least one workflow | - | DB |
| `org.info` | Info gauge with one series per org | `org_name`, `slug`, `plan`, `billing_status` | DB |

### Billing Metrics

Billing-aware observability layered onto the org model. Plan distribution, per-org execution volume vs plan limits, MRR, and subscription lifecycle counters.

**Cardinality control:** per-org execution gauges (`org.executions.30d`, `org.executions.month`, `org.plan_usage_ratio`) emit one series per *paid* org (pro/business/enterprise). Free-tier orgs are aggregated into a single series with `org_slug="_free"` to keep Prometheus storage bounded.

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `org.total_by_plan` | Org count grouped by plan and billing status | `plan`, `billing_status` | DB |
| `org.executions.30d` | Workflow executions per org in the last 30 days | `org_slug`, `plan` | DB |
| `org.executions.month` | Workflow executions per org since start of current calendar month | `org_slug`, `plan` | DB |
| `org.plan_usage_ratio` | Current-month executions / monthly plan limit (0 when unlimited) | `org_slug`, `plan` | DB |
| `mrr.usd_cents` | Approximate MRR in USD cents per plan (PLANS table * current tier) | `plan`, `tier`, `billing_status` | DB |
| `mrr.usd_cents.total` | Approximate committed MRR across all plans (excludes trials) | - | DB |
| `billing.subscription.created` | Subscriptions created (paid plan attached after checkout) | `plan`, `tier` | API |
| `billing.subscription.updated` | Subscription update events from the billing provider | `plan` | API |
| `billing.subscription.canceled` | Subscriptions canceled (provider-side or downgraded to free) | `plan`, `tier` | API |
| `billing.subscription.plan_changed` | Plan changes labeled by direction | `from_plan`, `to_plan`, `direction` (`upgrade` / `downgrade` / `tier_change`) | API |
| `billing.invoice.paid` | Invoices paid via the billing provider | `plan` | API |
| `billing.invoice.failed` | Invoice payment failures (`past_due` / `payment_failed`) | `plan` | API |
| `billing.overage.charged` | Overage charges issued for plan limit excess | `plan` | API |

**Billing status values** (`billing_status` label): `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `paused`, `none` (orgs without a subscription row).

**MRR caveat:** `mrr.usd_cents` is computed from `lib/billing/plans.ts` × the org's current `(plan, tier)` tuple, for every subscription in `active`, `trialing`, or `past_due` status. Stripe Dashboard remains the source of truth for accounting; this gauge exists for trend visibility only.

**Committed vs trial MRR:** `mrr.usd_cents.total` sums `active` and `past_due` subscriptions only. A trialing org has not been charged, so it must not appear in a revenue figure. Its list price still ships on `mrr.usd_cents` under `billing_status="trialing"`, so trial pipeline revenue stays visible:

```promql
# committed revenue in USD
max(keeperhub_mrr_usd_cents_total{cluster=~"$cluster", namespace="keeperhub"}) / 100

# trial pipeline revenue in USD, not yet earned
sum(max by (plan, tier, billing_status) (keeperhub_mrr_usd_cents{cluster=~"$cluster", namespace="keeperhub", billing_status="trialing"})) / 100
```

`past_due` counts as committed because the subscription is still on the plan and the invoice is being retried.

### Workflow Definition Metrics

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `workflow.total` | Total workflow definitions | - | DB |
| `workflow.by_visibility` | Workflows by visibility | `visibility` | DB |
| `workflow.anonymous` | Anonymous workflows | - | DB |

### Schedule Metrics

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `schedule.total` | Total workflow schedules | - | DB |
| `schedule.enabled` | Enabled workflow schedules | - | DB |
| `schedule.by_last_status` | Schedules by last run status | `status` | DB |

### Integration Metrics

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `integration.total` | Total integrations | - | DB |
| `integration.managed` | OAuth-managed integrations | - | DB |
| `integration.by_type` | Integrations by type | `type` | DB |

### Infrastructure Metrics

| Metric Name | Description | Labels | Source |
|-------------|-------------|--------|--------|
| `apikey.total` | Total API keys | - | DB |
| `chain.total` | Total blockchain networks configured | - | DB |
| `chain.enabled` | Enabled blockchain networks | - | DB |
| `wallet.total` | Total active org wallets | - | DB |
| `session.active` | Active (non-expired) sessions | - | DB |

---

## 6. BLOCK DISPATCHER

Per-chain liveness, subscription health, and SQS enqueue signals from the block-dispatcher pod (`keeperhub-scheduler/block-dispatcher`). All metrics live in the dispatcher's own in-process Prometheus registry exposed at `:3000/metrics` (separate from the main app's `/api/metrics`). Source code: `keeperhub-scheduler/lib/metrics.ts`.

The dashboard and alert rules for these metrics are defined in `techops-infrastructure/grafana/keeperhub-dashboards/` (separate Terraform PR).

### Gauges

| Metric Name | Description | Labels | Alert-worthy? |
|-------------|-------------|--------|---------------|
| `keeperhub_block_dispatcher_seconds_since_last_block` | Wall-clock seconds since this chain's lastProcessedBlock last advanced. THE primary alert signal — fires high when newHeads stops flowing even though the WSS appears alive. Computed at scrape time. | `chain` | YES — page if > 120s |
| `keeperhub_block_dispatcher_socket_age_seconds` | Wall-clock seconds since the current WSS subscription was established. Resets to 0 on every reconnect. | `chain` | no (debug) |
| `keeperhub_block_dispatcher_is_alive` | 0/1 mirroring `ChainMonitor.isAlive()`: running && hasSubscription && not stuck-reconnecting && not block-advance-stale. | `chain` | warn if 0 for >2 min |
| `keeperhub_block_dispatcher_is_reconnecting` | 1 when mid reconnect-with-backoff, 0 otherwise. | `chain` | no (debug) |
| `keeperhub_block_dispatcher_has_active_subscription` | 1 when eth_subscribe('newHeads') has completed and the callback is wired. | `chain` | no (debug) |
| `keeperhub_block_dispatcher_current_url_index` | 0 = primary, 1 = fallback. Tracks KEEP-557 silent-subscription failovers and primary-probe recoveries. | `chain` | no (debug) |
| `keeperhub_block_dispatcher_silent_reconnects_current` | Consecutive BLOCK_ADVANCE_TIMEOUT_MS firings on the current URL with no height advance in between. Resets to 0 on real height advance or URL flip. Early warning for upstream flakiness. | `chain` | warn if >= 1 for >5 min |
| `keeperhub_block_dispatcher_last_processed_block` | Highest block number this monitor has processed on the chain. | `chain` | no (debug) |
| `keeperhub_block_dispatcher_workflows_tracked` | Number of block-trigger workflows the monitor is tracking on this chain. | `chain` | no (debug) |
| `keeperhub_block_dispatcher_chains_monitored` | Total chains the pod is monitoring. | - | warn if 0 |

### Counters

| Metric Name | Description | Labels |
|-------------|-------------|--------|
| `keeperhub_block_dispatcher_blocks_received_total` | Blocks processed after dedup (height-advance) per chain. `rate()` gives block delivery rate; flatline means subscription silent. | `chain` |
| `keeperhub_block_dispatcher_blocks_matched_total` | Blocks that matched at least one workflow's `blockInterval`. `workflow_id` intentionally omitted to keep cardinality bounded. | `chain` |
| `keeperhub_block_dispatcher_ws_closes_total` | WebSocket closures per chain by trigger reason. | `chain`, `reason` (`upstream_close`, `pong_timeout`, `block_advance_timeout`, `socket_age_recycle`, `silent_failover`, `ping_send_failure`, `primary_probe_recovered`) |
| `keeperhub_block_dispatcher_reconnects_total` | Reconnect-with-backoff completions. | `chain`, `outcome` (`success`, `exhausted`) |
| `keeperhub_block_dispatcher_url_flips_total` | Auto-failover URL flips (KEEP-557). | `chain`, `direction` (`to_fallback`, `to_primary`) |
| `keeperhub_block_dispatcher_sqs_enqueue_total` | Workflow trigger enqueue attempts. Error rate climbing indicates an SQS/IAM/network issue downstream. | `chain`, `outcome` (`success`, `error`) |
| `keeperhub_block_dispatcher_unhandled_rejections_total` | Process-level unhandled promise rejections absorbed by the safety-net handler. Most common source: ethers v6 destroyProvider eth_unsubscribe cancellation. | - |

### Histograms

| Metric Name | Description | Labels | Buckets (ms) |
|-------------|-------------|--------|--------------|
| `keeperhub_block_dispatcher_reconnect_duration_ms` | Time from `handleDisconnect()` to next `Block subscription active`. | `chain` | 100, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000 |
| `keeperhub_block_dispatcher_block_lag_seconds` | `wall_clock - block.timestamp` when the block was received. p95 > 30s on a fast chain indicates upstream lag. | `chain` | 1, 2, 5, 10, 30, 60, 120, 300 |

---

## 7. SCHEDULE DISPATCHER

Dispatch-pass latency and enqueue signals from the schedule-dispatcher pod (`keeperhub-scheduler/schedule-dispatcher`). The dispatcher evaluates cron schedules once per minute and enqueues matching workflows to SQS. All metrics live in the dispatcher's own in-process Prometheus registry exposed at `:3000/metrics` on the health server (separate from the main app's `/api/metrics`), scraped via the `schedule.serviceMonitors` block in `deploy/keeperhub-stack/<env>/values.yaml`. Source code: `keeperhub-scheduler/schedule-dispatcher/metrics.ts`.

The alert rules for these metrics are defined in `techops-infrastructure/grafana/keeperhub-dashboards/` (see its `ALERTS_REFERENCE.md`, Schedule Dispatcher section).

### Counters

| Metric Name | Description | Labels |
|-------------|-------------|--------|
| `keeperhub_schedule_dispatcher_runs_total` | Dispatch passes completed (fetch succeeded and loop ran). `rate()` gives passes/min - should hold at ~1/min. | - |
| `keeperhub_schedule_dispatcher_triggered_total` | Workflow trigger messages successfully enqueued to SQS. A sustained zero over 90 minutes while schedules exist is the missed-hourly-trigger signal. | - |
| `keeperhub_schedule_dispatcher_errors_total` | Per-schedule errors during a dispatch pass (SQS failure, bad cron caught late). Distinct from fetch errors, which abort the whole pass and are not counted here. | - |

### Histograms

| Metric Name | Description | Labels | Buckets (s) |
|-------------|-------------|--------|-------------|
| `keeperhub_schedule_dispatcher_run_duration_seconds` | Wall-clock seconds per dispatch pass (fetch + evaluate + enqueue). The primary latency signal - p95 > 10s indicates DB or SQS slowness severe enough to threaten the trigger window. | - | 0.1, 0.5, 1, 2, 5, 10, 20, 30, 60 |

---

## Label Keys Reference

| Label Key | Description | Example Values |
|-----------|-------------|----------------|
| `workflow_id` | Unique workflow identifier | `wf_abc123` |
| `execution_id` | Unique execution identifier | `exec_xyz789` |
| `step_type` | Type of workflow step/action | `send-message`, `http-request` |
| `plugin_name` | Plugin name | `discord`, `sendgrid`, `web3` |
| `action_name` | Action name within plugin | `send-message`, `send-email` |
| `trigger_type` | How workflow was triggered | `manual`, `webhook`, `scheduled` |
| `status` | Execution status | `success`, `error`, `pending`, `running`, `cancelled` |
| `status_code` | HTTP status code | `200`, `400`, `500` |
| `error_type` | Classification of error | `validation`, `timeout`, `external` |
| `endpoint` | API endpoint path | `/api/workflows/webhook` |
| `service` | External service name | `discord-api`, `sendgrid-api` |
| `le` | Histogram bucket boundary | `100`, `250`, `500`, `+Inf` |
| `role` | Organization member role | `owner`, `admin`, `member` |
| `visibility` | Workflow visibility | `public`, `private` |
| `type` | Integration type | `discord`, `sendgrid`, `web3` |
| `email` | User email address (info gauge) | `user@example.com` |
| `name` | User display name (info gauge) | `John Doe` |
| `verified` | User email verified status (info gauge) | `true`, `false` |
| `org_name` | Organization name (info gauge) | `Acme Corp` |
| `slug` | Organization slug (info gauge) | `acme-corp` |
| `org_slug` | Organization slug for billing gauges (`_free` aggregates free-tier orgs, `_anonymous` for personal workflows) | `acme-corp`, `_free`, `_anonymous` |
| `plan` | Subscription plan | `free`, `pro`, `business`, `enterprise` |
| `tier` | Plan tier (none for free/enterprise) | `25k`, `50k`, `100k`, `250k`, `500k`, `1m`, `none` |
| `billing_status` | Subscription status | `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `paused`, `none` |
| `from_plan` / `to_plan` | Plan change source/target | `pro`, `business` |
| `direction` | Plan change direction | `upgrade`, `downgrade`, `tier_change` |

---

## Instrumentation Files

| Category | File | Functions |
|----------|------|-----------|
| Core | `keeperhub/lib/metrics/index.ts` | `getMetricsCollector()`, `createTimer()`, `withMetrics()` |
| DB Metrics | `keeperhub/lib/metrics/db-metrics.ts` | `getWorkflowStatsFromDb()`, `getStepStatsFromDb()`, `getDailyActiveUsersFromDb()`, `getUserStatsFromDb()`, `getOrgStatsFromDb()`, `getWorkflowDefinitionStatsFromDb()`, `getScheduleStatsFromDb()`, `getIntegrationStatsFromDb()`, `getInfraStatsFromDb()`, `getUserListFromDb()`, `getOrgListFromDb()` |
| API | `keeperhub/lib/metrics/instrumentation/api.ts` | `recordWebhookMetrics()`, `recordStatusPollMetrics()` |
| Plugin | `keeperhub/lib/metrics/instrumentation/plugin.ts` | `withPluginMetrics()` |

---

## Collectors

Metrics can be exported via different collectors based on `METRICS_COLLECTOR` env var:

| Collector | Environment Variable | Description |
|-----------|---------------------|-------------|
| Console (default) | `METRICS_COLLECTOR=console` | Structured JSON logs (CloudWatch/Datadog compatible) |
| Prometheus | `METRICS_COLLECTOR=prometheus` | Exposes `/api/metrics`, `/api/metrics/db`, `/api/metrics/api` endpoints |
| Noop | `METRICS_COLLECTOR=noop` | Silent collector (for testing) |

---

## Prometheus Configuration

Metrics are split across three endpoints to enable per-pod vs single-pod scraping:

| Endpoint | Content | Scrape Strategy |
|----------|---------|-----------------|
| `/api/metrics` | All metrics (backward compat) | Not scraped by default |
| `/api/metrics/db` | DB-sourced gauges only | One pod (hashmod in prod) |
| `/api/metrics/api` | API-process histograms/counters | All pods |

DB-sourced metrics are identical across pods (same database), so only one pod needs to be scraped. API-process metrics accumulate in-memory per pod and must be scraped from all pods.

### DB-Sourced Metrics

Before returning metrics, the `/api/metrics/db` endpoint queries the database to populate workflow/step metrics. This is necessary because workflow runner jobs (Kubernetes Jobs) exit before Prometheus can scrape them.

The following tables are queried:
- `workflow_executions` - execution counts by status, duration histogram
- `workflow_execution_logs` - step counts by type/status, step duration histogram
- `sessions` - daily active users (distinct users with sessions updated in 24h)
- `users` - total, verified, anonymous user counts; individual user info (email, name, verified)
- `workflows` - users/orgs with workflows
- `integrations` - users with integrations
- `organization` - total organization count; individual org info (name, slug)
- `member` - member counts by role
- `invitation` - pending invitation counts
- `workflow_schedules` - schedule counts, enabled status, last run status
- `api_keys` - API key count
- `chains` - blockchain network count
- `organization_wallets` - Active org wallet count

### Multi-Pod Aggregation (Important)

When running multiple pod replicas, all DB-sourced gauge metrics report identical values from each pod (since they query the same database). In Grafana/PromQL:

**Use `max()` instead of `sum()` for DB-sourced gauges:**

```promql
# CORRECT - returns actual count
max(keeperhub_user_total{cluster="prod", namespace="keeperhub"})

# WRONG - doubles count with 2 replicas
sum(keeperhub_user_total{cluster="prod", namespace="keeperhub"})
```

**For labeled gauges where the label is a *replication* dimension (same value across pods), use `max by (label)`:**

```promql
# CORRECT
max by (role) (keeperhub_org_members_by_role{...})
```

**For labeled gauges where the label is a *partition* dimension (different values per series that should be summed), combine `max` (to dedupe across pods) with `sum` (to aggregate across partitions):**

```promql
# CORRECT - sum across org_slug, dedupe across pods
sum by (status) (
  max by (status, org_slug) (keeperhub_workflow_executions_total{...})
)

# WRONG - returns max-across-orgs, NOT total
max by (status) (keeperhub_workflow_executions_total{...})

# WRONG - double-counts across pods
sum by (status) (keeperhub_workflow_executions_total{...})
```

`keeperhub_workflow_executions_total` and `keeperhub_workflow_execution_errors_total` are labeled by `org_slug` so dashboards/alerts can scope to managed clients. Personal/anonymous workflows are emitted under `org_slug="_anonymous"` so the sum across `org_slug` for a given status equals the unfiltered per-status total. To filter to managed clients, add `org_slug=~"techops-services|ajna"` (or the inverse `!~` for user workflows).

**Metrics requiring `max()` aggregation:**

| Category | Metrics |
|----------|---------|
| User | `user_total`, `user_verified_total`, `user_anonymous_total`, `user_with_workflows_total`, `user_with_integrations_total`, `user_active_daily` |
| Organization | `org_total`, `org_members_total`, `org_members_by_role`, `org_invitations_pending`, `org_with_workflows_total` |
| Workflow | `workflow_total`, `workflow_by_visibility`, `workflow_anonymous_total`, `workflow_executions_total`, `workflow_execution_errors_total`, `workflow_queue_depth`, `workflow_concurrent_count` |
| Schedule | `schedule_total`, `schedule_enabled_total`, `schedule_by_last_status` |
| Integration | `integration_total`, `integration_managed_total`, `integration_by_type` |
| Infrastructure | `apikey_total`, `wallet_total`, `chain_total`, `chain_enabled_total`, `session_active_total` |

**Why this happens:** Each pod queries the same PostgreSQL database and reports the same gauge value. With 2 pods reporting 21 users each, `sum()` returns 42 while `max()` correctly returns 21.

**API-sourced histograms and counters** can use `sum()` since each pod accumulates independent observations from requests it handles.

---

### Using delta() for Rate Queries

For rate and change-over-time queries on DB-sourced gauges, use PromQL's `delta()` function instead of separate counter metrics. This approach is simpler and more reliable in multi-pod deployments.

**Why delta() on gauges:**
- `delta()` calculates `last_value - first_value` within the time window
- All pods report identical gauge values from DB, so `delta()` gives consistent results
- No in-memory state tracking required
- No counter reset issues on pod restarts

**PromQL examples:**

```promql
# Total errors across all orgs (sum across org_slug, dedupe across pods)
sum(max by (org_slug) (keeperhub_workflow_execution_errors_total))

# Total successful executions across all orgs
sum(max by (status, org_slug) (keeperhub_workflow_executions_total{status="success"}))

# Errors added in the last hour, summed across orgs
sum(max by (org_slug) (delta(keeperhub_workflow_execution_errors_total[1h])))

# Executions in last 30 minutes by status, summed across orgs
sum by (status) (
  max by (status, org_slug) (delta(keeperhub_workflow_executions_total[30m]))
)

# Error rate over last hour, scoped to managed orgs
100 * sum(max by (org_slug) (
        delta(keeperhub_workflow_execution_errors_total{org_slug=~"techops-services|ajna"}[1h])
      ))
    / clamp_min(
        sum(max by (status, org_slug) (
          delta(keeperhub_workflow_executions_total{org_slug=~"techops-services|ajna"}[1h])
        )),
        1
      )
```

**delta() vs offset:**
- `offset 1h`: Takes a single data point from 1 hour ago (may be missing)
- `delta([1h])`: Uses first and last points in range (more stable with scrape intervals)

---

### Dashboard vs Alert Time Windows

Dashboards and alerts use different time window strategies by design:

| Component | Time Window | Purpose |
|-----------|-------------|---------|
| **Dashboard stat panels** | `$__range` (user-selected) | Exploration: "What happened in this time range?" |
| **Dashboard graphs** | `$__range` or fixed window | Visualization over selected period |
| **Alerts** | Fixed windows (`[1h]`, `[5m]`) | Monitoring: "Is something wrong right now?" |

**Why they differ:**

- **Dashboards** are for exploration and investigation. When looking at an incident from 3 days ago, you'd set the time picker to that period and expect all panels to reflect that range.

- **Alerts** must evaluate consistently regardless of who's viewing what dashboard. A "high error count" alert should always check the last hour, not vary based on dashboard settings.

**Example scenarios:**

```
Dashboard time picker: "Last 6 hours"
├── Workflow Errors stat: Shows errors in last 6 hours (delta[$__range])
├── Success Rate stat: Shows rate over last 6 hours
└── Alert evaluating: Still checks last 1 hour (delta[1h] > 10)
```

**This is intentional:** The stat panel shows "156 errors in 6 hours" while the alert only fires if "errors in last 1 hour > 10". Different questions, different windows.

**Labeled gauge aggregation:**

When a gauge has labels (e.g., `step_errors_total` with `step_type`), use:
```promql
# Wrong: max() picks only the highest label value
max(keeperhub_workflow_step_errors_total{...})

# Correct: max per label, then sum for total
sum(max by (step_type) (keeperhub_workflow_step_errors_total{...}))
```

---

### ServiceMonitor (Prometheus Operator)

Scraping is configured via two ServiceMonitors in the Helm chart values:

```yaml
serviceMonitors:
  enabled: true
  monitors:
    # API-process metrics: scrape all pods
    - name: api-metrics
      port: http
      path: /api/metrics/api
      interval: 30s
      scrapeTimeout: 10s
    # DB-sourced metrics: scrape one pod (prod uses hashmod)
    - name: db-metrics
      port: http
      path: /api/metrics/db
      interval: 30s
      scrapeTimeout: 10s
      relabelings:
        # hashmod on __address__ to select 1 of N pods
        - sourceLabels: [__address__]
          modulus: 2
          targetLabel: __tmp_hash
          action: hashmod
        - sourceLabels: [__tmp_hash]
          regex: "0"
          action: keep
```

The hashmod target relabeling prevents the scrape entirely for non-selected pods, so only one pod serves DB metrics to Grafana Cloud. Staging (1 replica) omits the hashmod since there is no duplication.

### Prometheus Metric Names

Prometheus metrics are prefixed with `keeperhub_` and use snake_case:

| Original Name | Prometheus Name | Type |
|---------------|-----------------|------|
| `workflow.executions.total` | `keeperhub_workflow_executions_total` | gauge |
| `workflow.execution.errors.total` | `keeperhub_workflow_execution_errors_total` | gauge |
| `workflow.execution.duration_ms` | `keeperhub_workflow_execution_duration_ms_bucket` | gauge |
| `workflow.execution.duration_ms` | `keeperhub_workflow_execution_duration_ms_sum` | gauge |
| `workflow.execution.duration_ms` | `keeperhub_workflow_execution_duration_ms_count` | gauge |
| `workflow.step.executions.total` | `keeperhub_workflow_step_executions_total` | gauge |
| `workflow.step.errors` | `keeperhub_workflow_step_errors_total` | gauge |
| `workflow.step.duration_ms` | `keeperhub_workflow_step_duration_ms_bucket` | gauge |
| `workflow.step.duration_ms` | `keeperhub_workflow_step_duration_ms_sum` | gauge |
| `workflow.step.duration_ms` | `keeperhub_workflow_step_duration_ms_count` | gauge |
| `workflow.queue.depth` | `keeperhub_workflow_queue_depth` | gauge |
| `workflow.concurrent.count` | `keeperhub_workflow_concurrent_count` | gauge |
| `user.active.daily` | `keeperhub_user_active_daily` | gauge |
| `user.total` | `keeperhub_user_total` | gauge |
| `user.verified` | `keeperhub_user_verified_total` | gauge |
| `user.anonymous` | `keeperhub_user_anonymous_total` | gauge |
| `user.with_workflows` | `keeperhub_user_with_workflows_total` | gauge |
| `user.with_integrations` | `keeperhub_user_with_integrations_total` | gauge |
| `user.info` | `keeperhub_user_info` | gauge |
| `org.total` | `keeperhub_org_total` | gauge |
| `org.members.total` | `keeperhub_org_members_total` | gauge |
| `org.members_by_role` | `keeperhub_org_members_by_role` | gauge |
| `org.invitations.pending` | `keeperhub_org_invitations_pending` | gauge |
| `org.with_workflows` | `keeperhub_org_with_workflows_total` | gauge |
| `org.info` | `keeperhub_org_info` | gauge |
| `workflow.total` | `keeperhub_workflow_total` | gauge |
| `workflow.by_visibility` | `keeperhub_workflow_by_visibility` | gauge |
| `workflow.anonymous` | `keeperhub_workflow_anonymous_total` | gauge |
| `schedule.total` | `keeperhub_schedule_total` | gauge |
| `schedule.enabled` | `keeperhub_schedule_enabled_total` | gauge |
| `schedule.by_last_status` | `keeperhub_schedule_by_last_status` | gauge |
| `integration.total` | `keeperhub_integration_total` | gauge |
| `integration.managed` | `keeperhub_integration_managed_total` | gauge |
| `integration.by_type` | `keeperhub_integration_by_type` | gauge |
| `apikey.total` | `keeperhub_apikey_total` | gauge |
| `chain.total` | `keeperhub_chain_total` | gauge |
| `chain.enabled` | `keeperhub_chain_enabled_total` | gauge |
| `wallet.total` | `keeperhub_wallet_total` | gauge |
| `session.active` | `keeperhub_session_active_total` | gauge |
| `api.webhook.latency_ms` | `keeperhub_api_webhook_latency_ms` | histogram |
| `api.status.latency_ms` | `keeperhub_api_status_latency_ms` | histogram |
| `plugin.action.duration_ms` | `keeperhub_plugin_action_duration_ms` | histogram |
| `ai.generation.duration_ms` | `keeperhub_ai_generation_duration_ms` | histogram |
| `plugin.invocations.total` | `keeperhub_plugin_invocations_total` | counter |
| `plugin.action.errors` | `keeperhub_plugin_action_errors_total` | counter |
| `api.errors.total` | `keeperhub_api_errors_total` | counter |

## Structured Log Format (Console Collector)

When using console collector, metrics are emitted as structured JSON (CloudWatch/Datadog compatible):

```json
{
  "timestamp": "2024-01-13T10:30:00.000Z",
  "level": "info",
  "metric": {
    "name": "workflow.execution.duration_ms",
    "type": "histogram",
    "value": 1234,
    "labels": {
      "workflow_id": "wf_123",
      "trigger_type": "webhook",
      "status": "success"
    }
  }
}
```
