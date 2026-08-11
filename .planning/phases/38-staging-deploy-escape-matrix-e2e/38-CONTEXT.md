# Phase 38: Staging Deploy + Escape-Matrix E2E - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Land the sandbox Pod in staging with a scrubbed ServiceAccount and no IRSA annotation, flip the main app's `SANDBOX_BACKEND` to `remote` via Helm values, and prove the three known exfil paths are closed via five E2E tests (TEST-01..05).

In scope: Helm values for a new `keeperhub-sandbox-staging` release via `techops-services/common` chart, raw YAML for the bits the chart does not cover (`automountServiceAccountToken: false` at SA + Pod level, ServiceAccount without IRSA/RoleBindings), Helm values patch on the main `keeperhub-staging` release for `SANDBOX_BACKEND=remote` + `SANDBOX_URL`, and a new E2E test file at `tests/e2e/sandbox-escape/` that runs the five escape-matrix assertions against the staging Service DNS.

Out of scope: NetworkPolicy (deferred to v1.9.x pending evidence; research/SUMMARY.md §Pre-Execution Blockers), `isolated-vm` (deferred), prod rollout and secret rotation (Phase 39), metrics/alerting (post-v1.9).

</domain>

<decisions>
## Implementation Decisions

### Deploy layout
- New directory `deploy/keeperhub-sandbox/staging/` (mirrors `deploy/keeperhub/staging/`).
- `values.yaml` invokes the same `techops-services/common` chart (v0.0.35) as the main app with a minimal configuration — no Ingress, no cron, no SSL termination (internal ClusterIP only).
- `sa.yaml` (raw manifest) creates `keeperhub-sandbox-staging` ServiceAccount with:
  - No `eks.amazonaws.com/role-arn` annotation (no IRSA → no AWS credential at escape).
  - `automountServiceAccountToken: false` at the SA level.
  - No associated RoleBinding/ClusterRoleBinding.
- `pod-automount.yaml` — raw manifest strategic-merge patch that sets `automountServiceAccountToken: false` at the Pod spec level (chart v0.0.35 doesn't expose this toggle, so ship via a separate admission-style patch via Helm post-render or kustomize overlay).
  - Approach: bundle the pod-level automount override into the main `values.yaml` if possible (`podSecurityContext`/custom), otherwise apply as a raw manifest AFTER helm upgrade using `kubectl patch deployment`.

### Main-app Helm values patch
- `deploy/keeperhub/staging/values.yaml` additions to `shared_env`:
  - `SANDBOX_BACKEND: { type: kv, value: "remote" }`
  - `SANDBOX_URL: { type: kv, value: "http://keeperhub-sandbox-staging.keeperhub.svc.cluster.local:8787" }`
- Keeps the env strategy consistent with the rest of the shared_env block.

### Container image
- The sandbox image is built by the existing CI (`test-unit-sandbox-remote` uses `docker build -f sandbox/Dockerfile`). Image publishing to ECR needs a sibling CI job or a manual `docker buildx` + `docker push` for the initial roll — documented in the SUMMARY as the operator step.
- `values.yaml` references the published image by tag.

### E2E tests
- New Playwright/vitest test file `tests/e2e/sandbox-escape/escape-matrix.spec.ts`.
- Each test POSTs a specific escape payload to the staging sandbox (via `kubectl port-forward` or via the main-app Code action triggered by Playwright) and asserts the returned outcome does NOT contain a sentinel planted in the main-pod's env.
- Uses the workflow-execution REST API so the test runs end-to-end (Code node → sandbox-client → sandbox service).

### Namespace + naming
- Same `keeperhub` namespace as the main app (per WORK-01).
- Release name: `keeperhub-sandbox-staging`.
- Service DNS: `keeperhub-sandbox-staging.keeperhub.svc.cluster.local:8787` (internal ClusterIP, port 8787 reserved from Phase 37).

### Apply strategy
- Operator runs `helm upgrade --install keeperhub-sandbox-staging ...` from the new values file.
- Operator runs `kubectl apply -f deploy/keeperhub-sandbox/staging/sa.yaml` for the scrubbed SA.
- Operator applies the pod-level automount override if the chart didn't handle it.
- Operator verifies via `kubectl exec` that `/var/run/secrets/kubernetes.io/serviceaccount/token` does NOT exist.
- E2E tests run manually or via a new CI job against staging with the API token.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `deploy/keeperhub/staging/values.yaml` — canonical Helm values shape using techops-services/common chart; 459 lines; includes `shared_env` anchor pattern, `parameterStore` + `kv` env types, `service`, `replicaCount`, `ingress` blocks.
- `deploy/keeperhub/staging/rbac.yaml` — raw manifest example for artifacts the chart doesn't cover (Role/RoleBinding for the main app); same approach applies to sandbox SA.
- `tests/e2e/playwright/` — existing Playwright E2E harness with auth helpers + workflow fixtures.
- `plugins/code/steps/run-code.ts` — Phase 37 step with `SANDBOX_BACKEND` selector already wired; flipping to `remote` in staging env is the only change needed on the main-app side.
- `lib/sandbox-client.ts` — already reads `SANDBOX_URL` from env once at module init; just needs the ClusterIP DNS passed via Helm values.

### Established Patterns
- Helm releases per env: `deploy/keeperhub/staging` + `deploy/keeperhub/prod`; mirror for sandbox.
- Raw-manifest side-files for chart gaps (RBAC, SA, NetworkPolicy) kept under the same env dir.
- Secret management via AWS Parameter Store via ExternalSecrets operator → chart's `parameterStore` env type.
- E2E tests in `tests/e2e/` run against a deployed env; not part of `pnpm test:unit`.

### Integration Points
- New release `keeperhub-sandbox-staging` in `keeperhub` namespace → `keeperhub-sandbox-staging.keeperhub.svc.cluster.local:8787`.
- Main app `keeperhub-staging` Deployment gets two new env entries (SANDBOX_BACKEND, SANDBOX_URL).
- E2E workflow: Playwright signs in, creates a workflow with a Code action, triggers the workflow via REST API, asserts sandbox outcome.

</code_context>

<specifics>
## Specific Ideas

- Use `kubectl apply -f deploy/keeperhub-sandbox/staging/sa.yaml --dry-run=client -o yaml` to validate SA YAML before apply.
- Add a smoke check to the SUMMARY: `kubectl exec -n keeperhub keeperhub-sandbox-staging-<hash> -- ls /var/run/secrets/kubernetes.io/serviceaccount/token 2>&1` must return "No such file or directory".
- E2E tests use the sandbox via the main-app API path (not direct POST /run) so they exercise the full selector + client + service stack as a production user would.

</specifics>

<deferred>
## Deferred Ideas

- **NetworkPolicy** — research/SUMMARY.md flags VPC CNI `enableNetworkPolicy=true` terraform flip + default-deny + kube-dns allow as the right move, but only after evidence that pod-level SA scrub is insufficient. Ship manifests with no NetworkPolicy in Phase 38; Phase 39 or a v1.9.1 can add it if the threat model demands.
- **`SidecarContainers` feature gate probe** — record cluster status during apply, not a hard dependency for v1.9.
- **Read-only rootfs + cgroup caps + IMDS-unreachable readiness probe** — deferred to v1.9.x per REQUIREMENTS.md Future Requirements.
- **Metrics + PagerDuty alerts on sandbox spawn/timeout/OOM** — post-v1.9.
- **Prod rollout, in-pod path retirement, secret rotation** — Phase 39.

</deferred>
