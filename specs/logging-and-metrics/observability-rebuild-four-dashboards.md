# Observability rebuild: four-dashboard spec

Status: DRAFT for review by Simon, Nick, Chong
Last updated: 2026-05-20
Linear: [KEEP-573](https://linear.app/keeperhubapp/issue/KEEP-573)

## Why four dashboards

The current single "KeeperHub" dashboard is asked to serve four different audiences at once - SRE during incidents, account team during SLA conversations, individual customer-support questions, and exec-facing growth narratives. None of those audiences are well served by a generic "everything" dashboard.

Four narrow dashboards, each with one named audience and a tight panel set, replace the one big page. Rules per dashboard:

- One sentence describing the audience and the question the dashboard answers.
- Maximum twelve panels per dashboard. If we need more, it's a sign the dashboard is being asked to do two jobs.
- Every panel has a documented metric source (Prometheus query, DB-sourced gauge, or both) and links to any alert that fires from the same data.
- Every panel must be answerable for "now", "last 1h", "last 24h" and "last 7d" without breaking. Histogram quantiles, gauges, and counters are all OK as long as the query is honest about which one it is.

### Known caveat: bulk `error_type` reclassification distorts SLI panels

When `scripts/backfill-error-classification.ts` is re-run, classifier rules change, or `error_type` is manually fixed on many rows at once, the DB-sourced gauge sees rows "leave" one `error_type` label-value series and "enter" another in the same scrape. PromQL's `increase()` reads the gain as new errors while the loss is treated as a counter reset, producing a phantom positive bump that contaminates SLI panels for one `[$__range]` window-length.

If the SLI panel suddenly tanks while DB shows no real new errors, check whether anyone ran a backfill or pushed a new classifier rule. The artifact self-clears once the reclassification timestamp falls outside the dashboard's time-range window. See [KEEP-592](https://linear.app/keeperhubapp/issue/KEEP-592) for the full root-cause analysis. Note: alert windows are short (2m) and recover before the artifact is visible, so paging is unaffected.

## Dashboard naming + URLs

| Dashboard | Slug | Path | Audience |
|---|---|---|---|
| A | `keeperhub-managed-client-slo` | `grafana/keeperhub-dashboards/git-sync/keeperhub-managed-client-slo.json` | exec + Sky/Ajna account team |
| B | `keeperhub-platform-health` | `grafana/keeperhub-dashboards/git-sync/keeperhub-platform-health.json` | TechOps / DevOps on-call |
| C | `keeperhub-customer-workflows` | `grafana/keeperhub-dashboards/git-sync/keeperhub-customer-workflows.json` | support / customer-success per-org debugging |
| D | `keeperhub-growth-revenue` | `grafana/keeperhub-dashboards/git-sync/keeperhub-growth-revenue.json` | founders + revenue-side |

All four are committed via Grafana git-sync (the path adopted on 2026-05-20). Alerts stay in TFCloud workspace `grafana-keeperhub-dashboards` (file `keeperhub_metrics_alerts.tf`).

---

## Dashboard A. Managed Client SLO

Audience: account owners, exec leadership, the Sky / Ajna account team.
Question it answers: "are we meeting the SLA we sold Sky and Ajna right now?"

Owner: Nick or Chong (recommend Nick - shipped the recent SLI/error panel rewrite).

### Variables

- `cluster` (default `techops-prod`, multi-select)
- `namespace` (default `keeperhub`)
- `managed_orgs_regex` (constant: `techops-services|ajna` - matches `local.managed_org_slugs_regex` in TF)

### Panels

| # | Title | Query | Type | Linked alert |
|---|---|---|---|---|
| 1 | SLI (success / (success + error)) - rolling 24h, per org | `100 * sum by (org_slug) (max by (org_slug, status) (increase(keeperhub_workflow_executions_total{cluster=~"$cluster", namespace=~"$namespace", status="success", org_slug=~"$managed_orgs_regex"}[24h]))) / clamp_min(sum by (org_slug) (max by (org_slug, status) (increase(keeperhub_workflow_executions_total{cluster=~"$cluster", namespace=~"$namespace", status=~"success\|error", org_slug=~"$managed_orgs_regex"}[24h]))), 1)` | stat (per-org), thresholds: 99.95 green / 99.0 yellow / below red | (no direct alert; budget-based alert tracked in [[error-budget-alerts]] follow-up) |
| 2 | SLI - rolling 7d, per org | same shape with `[7d]` | stat | - |
| 3 | SLI - rolling 30d, per org | same shape with `[30d]` | stat | - |
| 4 | SLI breach timeline (line, 24h) | `100 * (sum(rate(keeperhub_workflow_executions_total{...,status="success"}[5m])) / sum(rate(keeperhub_workflow_executions_total{...,status=~"success\|error"}[5m])))` per org | timeseries | - |
| 5 | Managed-client system errors (count, last 30m) | `sum by (org_slug) (max by (org_slug) (increase(keeperhub_workflow_executions_total{cluster=~"$cluster", namespace=~"$namespace", status="error", error_type="system", org_slug=~"$managed_orgs_regex"}[30m])))` | stat | `Keeperhub System Error` (Nick's 2m-window version) |
| 6 | Managed-client errors by category (last 24h) | `sum by (org_slug, error_category) (max by (org_slug, error_category) (increase(keeperhub_workflow_executions_total{cluster=~"$cluster", namespace=~"$namespace", status="error", org_slug=~"$managed_orgs_regex"}[24h])))` | bar chart | - |
| 7 | Time-to-first-byte (workflow p95 by trigger_type, 1h) | `histogram_quantile(0.95, sum by (trigger_type, le) (rate(keeperhub_workflow_execution_duration_ms_bucket{cluster=~"$cluster", namespace=~"$namespace", org_slug=~"$managed_orgs_regex"}[1h])))` | timeseries | - |
| 8 | Open alerts table (firing / pending) | Grafana annotations: `ALERTS{severity="critical", project="keeperhub", environment="prod"}` filtered to managed-client labels | table | - |
| 9 | Loki errors per org (24h) | `sum by (org_slug) (count_over_time({namespace="keeperhub", cluster="$cluster"} \| json \| org_slug=~"$managed_orgs_regex" \| level="error" [24h]))` | stat | - |

Notes:
- Panels 1-3 use the same query shape, only window differs. Keep them as separate stat panels for the "snapshot" feel rather than collapsing into a dropdown.
- Panel 5 is the alerting-aligned view; matches the `Keeperhub System Error` PromQL exactly so on-call sees the same number that fired the page.
- No "User Error" panels here - that's Dashboard C territory. This dashboard is exec-facing and the chart audience doesn't need to distinguish.

---

## Dashboard B. Platform Health

Audience: TechOps / DevOps on-call during an incident. "The first dashboard to open at 3am."
Question it answers: "what's actually wrong on the platform right now?"

Owner: Chong or Nick.

### Variables

- `cluster` (multi, default `techops-prod`)
- `namespace` (default `keeperhub`)

### Panels (grouped into rows)

#### Row 1: System errors (last 30m)

| # | Title | Query | Type |
|---|---|---|---|
| 1 | System errors right now | `sum(max by (org_slug) (increase(keeperhub_workflow_executions_total{cluster=~"$cluster", namespace=~"$namespace", status="error", error_type="system"}[30m])))` | stat (red threshold > 0) |
| 2 | System errors by category (30m) | `sum by (error_category) (max by (org_slug, error_category) (increase(keeperhub_workflow_executions_total{...,status="error",error_type="system"}[30m])))` | bar chart |
| 3 | System errors by org_slug (top 10, 30m) | `topk(10, sum by (org_slug) (max by (org_slug) (increase(keeperhub_workflow_executions_total{...,status="error",error_type="system"}[30m]))))` | bar chart |

#### Row 2: Cluster + pod state

| # | Title | Query | Type |
|---|---|---|---|
| 4 | Pod state by deployment | `count by (created_by_kind, namespace, deployment) (kube_pod_status_phase{cluster="$cluster", namespace="$namespace", phase!~"Running\|Succeeded"})` | stat row per phase |
| 5 | Pod restarts (last 1h) | `sum by (pod) (increase(kube_pod_container_status_restarts_total{cluster="$cluster", namespace="$namespace"}[1h])) > 0` | timeseries |
| 6 | Memory headroom per deployment | `100 * (1 - sum by (deployment) (container_memory_working_set_bytes{cluster="$cluster", namespace="$namespace"}) / sum by (deployment) (kube_pod_container_resource_limits{cluster="$cluster", namespace="$namespace", resource="memory"}))` | timeseries |

#### Row 3: Queue + executor saturation

| # | Title | Query | Type | Notes |
|---|---|---|---|---|
| 7 | Queue depth (max across pods) | `max(keeperhub_workflow_queue_depth{cluster=~"$cluster", namespace=~"$namespace"})` | stat | TODO: collector emits different values per pod - fix in [[KEEP-tbd-global-queue-depth]] |
| 8 | Concurrent workflows running (snapshot) | `max(keeperhub_workflow_concurrent_count{cluster=~"$cluster", namespace=~"$namespace"})` | stat | Replaces the current `delta(...)` formula (wrong math, panel #6 on old dashboard) |
| 9 | Pending → success p95 transition latency | `histogram_quantile(0.95, sum(rate(keeperhub_workflow_execution_duration_ms_bucket{cluster=~"$cluster", namespace=~"$namespace"}[5m])) by (le))` | timeseries |

#### Row 4: RPC + external deps

| # | Title | Query | Type |
|---|---|---|---|
| 10 | RPC primary/fallback state per chain | `sum by (chain_id, endpoint_role) (keeperhub_rpc_active_endpoint{cluster=~"$cluster", namespace=~"$namespace"})` | stat per chain |
| 11 | RPC failover events (1h) | `sum by (chain_id) (increase(keeperhub_rpc_failover_total{cluster=~"$cluster", namespace=~"$namespace"}[1h]))` | bar chart |
| 12 | External dependency health (Etherscan / Turnkey / Stripe / Sentry) | requires Phase 3 K (currently NOT emitted) - placeholder card pointing to ticket | (placeholder) |

#### Row 5: Metric + log scrape health

| # | Title | Query | Type |
|---|---|---|---|
| - | Scrape failures by job | `up{cluster=~"$cluster", namespace=~"$namespace"} == 0` | table |
| - | Loki ingestion error rate | `sum by (tenant) (rate(loki_distributor_ingester_append_failures_total[5m]))` | timeseries |

Notes:
- Row 4's external-dep panel is intentionally a placeholder until Phase 3 K lands.
- This dashboard's job is "tell me what to look at" - panels are not exhaustive views, they're triage signals. Detail goes to per-component dashboards.

---

## Dashboard C. Customer Workflows

Audience: support, customer success, anyone debugging one specific org's experience.
Question it answers: "is org X experiencing failures, and if so, where do I look in Loki to debug?"

Owner: Sasha (per original ticket suggestion).

### Variables

- `cluster` (default `techops-prod`)
- `namespace` (default `keeperhub`)
- `org_slug` (single-select, populated from `label_values(keeperhub_workflow_executions_total, org_slug)`)
- `workflow_id` (optional, populated from `label_values(keeperhub_workflow_executions_total{org_slug="$org_slug"}, workflow_id)`)

### Panels

| # | Title | Query | Type |
|---|---|---|---|
| 1 | Org-scope success rate (1h, 24h, 7d) | `100 * sum(increase(keeperhub_workflow_executions_total{cluster=~"$cluster", namespace=~"$namespace", status="success", org_slug="$org_slug"}[$__range])) / clamp_min(sum(increase(keeperhub_workflow_executions_total{cluster=~"$cluster", namespace=~"$namespace", status=~"success\|error", org_slug="$org_slug"}[$__range])), 1)` | stat row (3 cells: 1h, 24h, 7d) |
| 2 | Org executions by status (24h) | `sum by (status) (max by (status) (increase(keeperhub_workflow_executions_total{...,org_slug="$org_slug"}[24h])))` | pie chart |
| 3 | Org errors by error_category (24h) | `sum by (error_category) (max by (error_category) (increase(keeperhub_workflow_executions_total{...,org_slug="$org_slug", status="error"}[24h])))` | bar chart |
| 4 | Org errors split by error_type (24h) | `sum by (error_type) (max by (error_type) (increase(keeperhub_workflow_executions_total{...,org_slug="$org_slug", status="error"}[24h])))` | pie chart - user vs system |
| 5 | Per-workflow_id error table (24h) | `topk(20, sum by (workflow_id, error_category, error_type) (increase(keeperhub_workflow_executions_total{...,org_slug="$org_slug", status="error"}[24h])))` | table |
| 6 | Workflow p95 latency for this org (1h, by workflow_id) | `histogram_quantile(0.95, sum by (workflow_id, le) (rate(keeperhub_workflow_execution_duration_ms_bucket{...,org_slug="$org_slug"}[1h])))` | timeseries |
| 7 | Top error contexts for this org (1h) | `topk(10, sum by (error_context) (increase(keeperhub_errors_total{...,org_slug="$org_slug"}[1h])))` | table |
| 8 | Loki drilldown link (pre-filled) | Static markdown panel with link: `{namespace="keeperhub", cluster="$cluster"} \| json \| org_slug="$org_slug"` and `... \| execution_id="<paste-here>"` for execution-level debugging | text panel |
| 9 | Recent ERROR log lines for this org (last 1h) | LogQL: `{namespace="$namespace", cluster="$cluster"} \| json \| org_slug="$org_slug" \| level="error"` limit 50 | logs |

Notes:
- Panel 5 doubles as the entry point to per-(org, workflow_id) debugging.
- Panel 8 is the doc you'd hand to a support engineer who's never seen Grafana before.
- The `workflow_id` template variable is OPTIONAL - if left blank, all panels show the org-wide view. If selected, panels 5-7 narrow further.

---

## Dashboard D. Growth + Revenue

Audience: founders + revenue conversations.
Question it answers: "is the business healthy this month?"

Owner: Sasha.

### Variables

- `cluster` (default `techops-prod`)
- `namespace` (default `keeperhub`)

### Panels (grouped into rows)

#### Row 1: MRR + plan distribution

| # | Title | Query | Type |
|---|---|---|---|
| 1 | MRR (USD) | `max(keeperhub_mrr_usd_cents_total{cluster=~"$cluster", namespace=~"$namespace"}) / 100` | stat (currency) |
| 2 | MRR change vs 30d ago | `(max(keeperhub_mrr_usd_cents_total) - max(keeperhub_mrr_usd_cents_total offset 30d)) / 100` | stat (delta, +/-) |
| 3 | Orgs by plan | `sum by (plan) (max by (plan, tier, billing_status) (keeperhub_org_total_by_plan{...}))` | pie chart |
| 4 | Paid orgs / Free orgs / Past due (3 stats) | sum filtered by `plan!="free", billing_status=~"active\|trialing"` etc. | stat row |

#### Row 2: Growth funnel

| # | Title | Query | Type |
|---|---|---|---|
| 5 | Signup → first workflow → first integration → first execution | (4 stat panels with same metric set, or one timeseries with 4 series) | stat row or timeseries |
| 6 | Total / verified / DAU users | `max(keeperhub_user_total)`, `max(keeperhub_user_verified_total)`, `max(keeperhub_user_active_daily)` | stat row |
| 7 | New users last 7d / 30d | `max(keeperhub_user_total) - max(keeperhub_user_total offset 7d)` (and 30d) | stat row |

#### Row 3: Plan utilization

| # | Title | Query | Type |
|---|---|---|---|
| 8 | Orgs approaching plan limit (table) | `max by (org_slug, plan) (keeperhub_org_plan_usage_ratio) > 0.8` | table (sorted by usage desc) |
| 9 | Plan usage distribution | `histogram` of `keeperhub_org_plan_usage_ratio` | heatmap or distribution chart |

#### Row 4: Integrations + workflows

| # | Title | Query | Type |
|---|---|---|---|
| 10 | Total integrations by type | `max by (type) (keeperhub_integration_by_type)` | pie chart |
| 11 | Total workflows (private vs public) | `max by (visibility) (keeperhub_workflow_by_visibility)` | pie chart |
| 12 | Enabled chains | `max(keeperhub_chain_enabled_total)` | stat |

Notes:
- MRR delta (panel 2) requires `offset 30d` which only works once we have 30+ days of metric history retained. If Grafana Cloud retention is shorter than 30d we substitute a daily snapshot recorded into Prometheus' long-term storage.
- Panels 5 + 7 require lifecycle counters from Phase 3 L (workflow created/deleted, integration connected). Mark as TODO with link until those land.

---

## Migration plan

Phase 1.5 (finish before declaring Phase 1 done):
- This spec is reviewed and approved.
- Implementation owners explicitly assigned (right now this doc suggests A→Nick, B→Chong, C+D→Sasha; final assignment in the review PR).

Phase 2:
- Each dashboard built in `grafana/keeperhub-dashboards/git-sync/` as its own JSON file.
- The current single `keeperhub.json` retained as a redirect-style stub for ~2 weeks during cutover, then deleted.
- Each dashboard PR includes:
  - JSON file in `git-sync/`
  - One-paragraph addition to `grafana/keeperhub-dashboards/ALERTS_REFERENCE.md` describing the dashboard's audience and linked alerts.
  - Link added to this spec doc under the dashboard's section.

Phase 3:
- External-dependency health metrics (Phase 3 K from the parent ticket) unblock Dashboard B row 4 panel 12.
- Lifecycle counters (Phase 3 L) unblock Dashboard D row 2 panels 5 and 7.

## Open questions for the review

1. **Are 12 panels per dashboard the right cap?** Dashboard B in particular runs close to it.
2. **Should Dashboard A include a Loki error feed?** Panel 9 is sketchy - it's useful for incident reconstruction but may add log query cost. Open to dropping it.
3. **Org membership of "managed" - is it just `techops-services` and `ajna` forever, or do we need a variable so the SRE side can add another managed client without a TF change?** The `local.managed_org_slugs_regex` is a TF constant today.
4. **Dashboard C `workflow_id` variable - should it default to "All" or force a selection?** If forced, the dashboard breaks on first load. If "All", panels 5-7 lose their narrowing value.
5. **Are there alerts we should add now that the panels exist?** e.g. "Org plan limit >90% utilization" for Dashboard D panel 8.

## Acceptance for Phase 1 (in parent ticket)

- [x] Spec written
- [ ] Spec reviewed by Simon
- [ ] Owners explicitly assigned per dashboard (currently suggested but not final)
