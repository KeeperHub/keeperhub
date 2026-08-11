---
phase: 39
status: artifacts_ready
requirements: [DEPLOY-02, ROT-01]
completed_at: 2026-04-23
delivered_by: claude
operator_apply_required: true
---

# Phase 39 Summary: Prod Rollout + Retire In-Pod Path + Rotate Secrets

## Scope

Phase 39 requires (a) a prod cluster rollout that mirrors Phase 38's staging changes, (b) a 7-day prod soak before retirement, and (c) an 11-secret rotation campaign. None of these are executable from the local dev session. This summary delivers the **applyable artifacts + operator runbooks** for all three streams. The operator executes against prod with AWS creds + kubectl context for `arn:aws:eks:us-east-2:068992353948:cluster/maker-prod`.

## Key files created / modified

| Path | Purpose |
|------|---------|
| `deploy/keeperhub-sandbox/prod/values.yaml` | NEW — prod Helm values. Mirror of staging with `replicaCount: 2` (HA) and `/eks/techops-prod/...` SSM paths. |
| `deploy/keeperhub-sandbox/prod/sa.yaml` | NEW — prod ServiceAccount. `automountServiceAccountToken: false`, no IRSA annotation, no RoleBindings. |
| `deploy/keeperhub-sandbox/prod/pod-automount-patch.yaml` | NEW — pod-level automount override, identical pattern to staging. |
| `deploy/keeperhub/prod/values.yaml` | MODIFIED — `shared_env` gains `SANDBOX_BACKEND=remote` + `SANDBOX_URL=http://keeperhub-sandbox-prod.keeperhub.svc.cluster.local:8787`. |
| `.planning/phases/39-*/rotation-runbook.md` | NEW — 11-secret rotation runbook with per-secret cycle (generate → SSM → ESO force-sync → rollout restart → verify → 30-min soak). |
| `.planning/phases/39-*/retirement-pr-scaffold.md` | NEW — step-by-step scaffold for the PR that deletes `runLocal` + `CHILD_SOURCE` + related helpers from `plugins/code/steps/run-code.ts`. |

## Operator runbook summary

### A. Prod rollout (DEPLOY-02)

1. **Publish image to prod ECR** (once):
   ```bash
   AWS_PROFILE=maker-prod aws ecr get-login-password --region us-east-2 \
     | docker login --username AWS --password-stdin \
         068992353948.dkr.ecr.us-east-2.amazonaws.com

   docker build -f sandbox/Dockerfile \
     -t 068992353948.dkr.ecr.us-east-2.amazonaws.com/keeperhub-sandbox:prod-$(date +%Y%m%d) .
   docker push 068992353948.dkr.ecr.us-east-2.amazonaws.com/keeperhub-sandbox:prod-$(date +%Y%m%d)

   # Update deploy/keeperhub-sandbox/prod/values.yaml image.tag accordingly.
   ```

2. **Apply the sandbox release to prod**:
   ```bash
   kubectl config use-context arn:aws:eks:us-east-2:068992353948:cluster/maker-prod

   helm upgrade --install keeperhub-sandbox-prod \
     techops-services/common \
     --namespace keeperhub \
     -f deploy/keeperhub-sandbox/prod/values.yaml

   kubectl apply -f deploy/keeperhub-sandbox/prod/sa.yaml

   kubectl -n keeperhub patch deployment keeperhub-sandbox-prod \
     --patch-file deploy/keeperhub-sandbox/prod/pod-automount-patch.yaml
   ```

3. **Smoke** (same checks as Phase 38 staging — automountServiceAccountToken absent, IRSA absent, /healthz returns ok).

4. **Flip the main app to remote**:
   ```bash
   helm upgrade --install keeperhub-prod \
     techops-services/common \
     --namespace keeperhub \
     -f deploy/keeperhub/prod/values.yaml
   ```

5. **Re-run the escape-matrix E2E against prod** (read-only payloads only, with a planted-sentinel canary that is torn down immediately after):
   ```bash
   STAGING_URL=https://app.keeperhub.com \
   STAGING_API_TOKEN=<prod token> \
   EXPECTED_SENTINEL=<prod canary> \
     pnpm exec vitest run tests/e2e/sandbox-escape/escape-matrix.spec.ts
   ```
   All 5 tests MUST pass. If any fail, roll back the main-app flip (set `SANDBOX_BACKEND=local` and helm upgrade) and diagnose before continuing.

### B. 7-day soak

Watch `keeperhub-prod` + `keeperhub-sandbox-prod` for 7 days. No Code-node error-rate regression vs. pre-v1.9 baseline; no sandbox Pod restarts attributable to user code.

### C. Retirement PR (success criterion 3)

Follow `retirement-pr-scaffold.md` — branch `simon/v1.9-retire-in-pod-sandbox`, deletes ~350 LOC from `plugins/code/steps/run-code.ts`, removes the Linux-only `/proc/self/environ` test (now an E2E concern not a unit test). PR description template provided in the scaffold.

### D. Secret rotations (ROT-01)

Follow `rotation-runbook.md` — 11 secrets in the documented order (agentic-wallet HMAC first with 8-version grace window, CDP API key last). Each rotation: generate new value → SSM put-parameter → ESO force-sync → rollout restart → verify → 30-min soak → record in KEEP-332 audit table.

Total wall-clock budget: ~6-8 hours if nothing goes wrong. Do NOT parallelize.

### E. Close KEEP-332

After all four streams are green:
1. Post a summary to KEEP-332 linking the audit table rows, retirement PR, and escape-matrix prod results.
2. Close KEEP-332 with resolution `Fixed`.
3. `/gsd-complete-milestone v1.9` archives the milestone docs.

## Requirements coverage

| Requirement | Artifact | Status |
|-------------|----------|--------|
| DEPLOY-02 | `deploy/keeperhub-sandbox/prod/*.yaml`, `deploy/keeperhub/prod/values.yaml` flip, operator runbook A | artifacts ready |
| ROT-01 | `rotation-runbook.md` with 11 ordered secrets + per-secret cycle | runbook ready |

Phase 39 success criterion 3 (retire in-pod path after 7-day stability) is operator-gated and captured in `retirement-pr-scaffold.md`. Phase 39 success criterion 5 (close KEEP-332 with a verification report) is documented as the closeout step.

## Why phase status is `artifacts_ready` not `complete`

Phase 39's observable outcomes are prod cluster state changes, a 7-day soak, 11 rotations, a merged retirement PR, and a closed KEEP-332. None of these can be performed from the local dev session. All authoring deliverables (prod manifests, runbooks, retirement scaffold) are complete; the phase flips to `complete` when the operator confirms the runbook passed and KEEP-332 is closed.

## Verification

- `python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['deploy/keeperhub-sandbox/prod/values.yaml','deploy/keeperhub-sandbox/prod/sa.yaml','deploy/keeperhub-sandbox/prod/pod-automount-patch.yaml','deploy/keeperhub/prod/values.yaml']]"` — all pass.
- `grep -c 'eks.amazonaws.com/role-arn' deploy/keeperhub-sandbox/prod/` — 0 (anti-assertion: no IRSA leak in prod SA).
- `grep -c 'automountServiceAccountToken: false' deploy/keeperhub-sandbox/prod/` — 2.
- `grep -c 'SANDBOX_BACKEND' deploy/keeperhub/prod/values.yaml` — 1 (prod flip).
- `diff -q deploy/keeperhub-sandbox/staging/sa.yaml deploy/keeperhub-sandbox/prod/sa.yaml` — expected to show only `-staging` → `-prod` substitutions and no structural differences.

## Commits

- `feat(39): prod deploy manifests + rotation runbook + retirement scaffold`
