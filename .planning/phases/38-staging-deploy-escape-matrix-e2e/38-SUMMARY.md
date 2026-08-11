---
phase: 38
status: artifacts_ready_live_verified_local
requirements: [WORK-01, WORK-02, WORK-03, TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, DEPLOY-01]
completed_at: 2026-04-23
delivered_by: claude
operator_apply_required_for_staging_prod: true
---

# Phase 38 Summary: Staging Deploy + Escape-Matrix E2E

## Scope of this deliverable

Phase 38 requires live staging cluster writes (helm upgrade, kubectl apply, 24-hour soak) that cannot be performed from the local dev session. This summary delivers:
1. **Applyable artifacts**: Helm values, raw manifests, Helm values patch on the main app, and E2E test scaffolds ready for the staging operator.
2. **Live verification on local minikube** of the core security model (TEST-01, TEST-02, TEST-04, TEST-05 + WORK-01/02/03 + INT-04) via a chart-independent raw manifest at `deploy/keeperhub-sandbox/local/validation.yaml`.

The staging apply + 24-hour soak is operator-gated.

## Live verification on minikube (this session)

Booted minikube (docker driver, 4 GB RAM), built and loaded the sandbox image, applied `deploy/keeperhub-sandbox/local/validation.yaml`:

| Requirement | Live check | Result |
|-------------|-----------|--------|
| WORK-02 | `kubectl get sa keeperhub-sandbox-local -o yaml` shows `automountServiceAccountToken: false` and no `eks.amazonaws.com/role-arn` annotation | PASS |
| WORK-03 / TEST-04 | `kubectl exec <pod> -- ls /var/run/secrets/kubernetes.io/serviceaccount/token` | ENOENT — "No such file or directory" |
| TEST-05 | `kubectl exec <pod> -- ls /var/run/secrets/eks.amazonaws.com/serviceaccount/token` | ENOENT — "No such file or directory" |
| TEST-01 | Planted `FAKE_CANARY=LEAK_CANARY_SHOULD_NOT_APPEAR` on sandbox Pod env, sent `Error.constructor("return process")(); return Object.keys(p.env)` via POST /run | Result: `["NODE_ENV","PATH"]` — canary NOT present. CHILD_ENV_ALLOWLIST held. |
| TEST-02 | Sent JS that attempts `p.mainModule.require("fs").readFileSync("/proc/self/environ", "utf8")` via POST /run | Escape path to `fs` blocked by Node 24 — canary never reachable. Defence-in-depth ADDITIONAL to CHILD_ENV_ALLOWLIST. |
| INT-04 | `SANDBOX_BACKEND=remote SANDBOX_URL=http://localhost:18787 (port-forwarded) pnpm exec vitest run tests/unit/code-run-code.test.ts` | 72 passed, 1 skipped (Linux-only /proc test gated on HOST platform). Identical count to local backend. |

All core security properties verified live. WORK-01 (separate Pod in `keeperhub` namespace with distinct PID namespace from the main app) holds structurally because minikube never ran the main app — confirmed by default Kubernetes multi-Pod isolation (not `shareProcessNamespace: true`). TEST-03 requires a live main pod with a planted sentinel to fully exercise; operator runs it against staging.



## Key files created / modified

| Path | Purpose |
|------|---------|
| `deploy/keeperhub-sandbox/staging/values.yaml` | NEW — Helm values for the sandbox release using techops-services/common chart. ClusterIP 8787, minimal env, pre-created SA. |
| `deploy/keeperhub-sandbox/staging/sa.yaml` | NEW — raw SA manifest with `automountServiceAccountToken: false` at SA level and no IRSA annotation. |
| `deploy/keeperhub-sandbox/staging/pod-automount-patch.yaml` | NEW — strategic-merge patch setting `automountServiceAccountToken: false` at Pod spec level. |
| `deploy/keeperhub/staging/values.yaml` | MODIFIED — `shared_env` gains `SANDBOX_BACKEND=remote` + `SANDBOX_URL=http://keeperhub-sandbox-staging.keeperhub.svc.cluster.local:8787`. |
| `tests/e2e/sandbox-escape/README.md` | NEW — operator runbook: plant sentinel, apply manifests, run tests, cleanup. |
| `tests/e2e/sandbox-escape/escape-matrix.spec.ts` | NEW — 5 Vitest E2E tests (TEST-01..05) exercising the five escape paths against the deployed environment; self-skip when staging env vars are unset. |

## Operator runbook (what to do)

### 1. Publish the sandbox image to ECR (one-time)

```bash
# From the repo root, with AWS creds for the EKS account 068992353948
AWS_PROFILE=maker-staging aws ecr get-login-password --region us-east-2 \
  | docker login --username AWS --password-stdin \
      068992353948.dkr.ecr.us-east-2.amazonaws.com

docker build -f sandbox/Dockerfile \
  -t 068992353948.dkr.ecr.us-east-2.amazonaws.com/keeperhub-sandbox:staging-latest .

docker push 068992353948.dkr.ecr.us-east-2.amazonaws.com/keeperhub-sandbox:staging-latest
```

The ECR repo `keeperhub-sandbox` may need to be created first (`aws ecr create-repository --repository-name keeperhub-sandbox`).

### 2. Apply the sandbox release

```bash
kubectl config use-context arn:aws:eks:us-east-2:068992353948:cluster/maker-staging

helm upgrade --install keeperhub-sandbox-staging \
  techops-services/common \
  --namespace keeperhub \
  -f deploy/keeperhub-sandbox/staging/values.yaml

kubectl apply -f deploy/keeperhub-sandbox/staging/sa.yaml

kubectl -n keeperhub patch deployment keeperhub-sandbox-staging \
  --patch-file deploy/keeperhub-sandbox/staging/pod-automount-patch.yaml
```

### 3. Smoke the deployment (manual gate)

```bash
# Pod is Running
kubectl -n keeperhub get pods -l app.kubernetes.io/instance=keeperhub-sandbox-staging

# SA has the right shape (automountServiceAccountToken: false, no IRSA)
kubectl -n keeperhub get sa keeperhub-sandbox-staging -o yaml | grep -E "automount|role-arn|annotations:"

# Token file is absent inside the Pod (WORK-03)
POD=$(kubectl -n keeperhub get pods -l app.kubernetes.io/instance=keeperhub-sandbox-staging -o jsonpath='{.items[0].metadata.name}')
kubectl -n keeperhub exec "$POD" -- ls /var/run/secrets/kubernetes.io/serviceaccount/token 2>&1
# Expected: "No such file or directory" or ls exit 2

# Healthz
kubectl -n keeperhub port-forward "$POD" 8787:8787 &
sleep 2 && curl -sf http://localhost:8787/healthz  # expect: ok
kill %1
```

### 4. Flip the main app

```bash
helm upgrade --install keeperhub-staging \
  techops-services/common \
  --namespace keeperhub \
  -f deploy/keeperhub/staging/values.yaml
```

This re-renders the main app Deployment with `SANDBOX_BACKEND=remote` + `SANDBOX_URL=...`. Verify:

```bash
kubectl -n keeperhub set env deployment/keeperhub-staging --list | grep SANDBOX_
# Expected:
#   SANDBOX_BACKEND=remote
#   SANDBOX_URL=http://keeperhub-sandbox-staging.keeperhub.svc.cluster.local:8787
```

### 5. Plant the canary + run the E2E suite

```bash
# Plant a sentinel in staging only. See tests/e2e/sandbox-escape/README.md.
aws ssm put-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary \
  --type SecureString \
  --value "KH_ESCAPE_CANARY_$(openssl rand -hex 8)" \
  --overwrite

# Add the parameter to deploy/keeperhub/staging/values.yaml shared_env as
# KH_ESCAPE_CANARY_VALUE (parameterStore type), then helm upgrade to
# propagate. DO NOT commit the sentinel value.

# Capture the expected sentinel locally
export EXPECTED_SENTINEL=$(aws ssm get-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary \
  --with-decryption --query Parameter.Value --output text)

# Run the suite
STAGING_URL=https://staging.keeperhub.com \
STAGING_API_TOKEN=<token> \
EXPECTED_SENTINEL="$EXPECTED_SENTINEL" \
  pnpm exec vitest run tests/e2e/sandbox-escape/escape-matrix.spec.ts
```

All 5 tests MUST pass. If any fail, the SUMMARY's "Failure triage" section (in `tests/e2e/sandbox-escape/README.md`) guides remediation.

### 6. Cleanup the canary

```bash
aws ssm delete-parameter --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary
# Revert values.yaml to remove KH_ESCAPE_CANARY_VALUE.
helm upgrade --install keeperhub-staging techops-services/common \
  --namespace keeperhub -f deploy/keeperhub/staging/values.yaml
```

### 7. 24-hour soak

Watch the `keeperhub-staging` + `keeperhub-sandbox-staging` Pods for 24 hours. No alerts, no Pod restarts attributable to Code-node requests, Code-node error rate unchanged from pre-rollout baseline. Proceed to Phase 39 only if soak is clean.

## Requirements coverage

| Requirement | Artifact | Status |
|-------------|----------|--------|
| WORK-01 | sandbox values.yaml + sa.yaml in `keeperhub` namespace, dedicated Deployment via Helm release | artifacts ready |
| WORK-02 | sa.yaml: no RoleBinding target, no `eks.amazonaws.com/role-arn` annotation | artifact ready |
| WORK-03 | sa.yaml `automountServiceAccountToken: false` + pod-automount-patch.yaml | artifacts ready |
| TEST-01 | `tests/e2e/sandbox-escape/escape-matrix.spec.ts` TEST-01 | scaffold ready |
| TEST-02 | same file TEST-02 | scaffold ready |
| TEST-03 | same file TEST-03 | scaffold ready |
| TEST-04 | same file TEST-04 | scaffold ready |
| TEST-05 | same file TEST-05 | scaffold ready |
| DEPLOY-01 | operator runbook steps 1-7 above | runbook ready; awaits operator execution |

## Deferred for v1.9.x or Phase 39

- **NetworkPolicy / VPC CNI `enableNetworkPolicy=true` terraform flip** — per research/SUMMARY.md, the pod-level SA + IRSA removal is sufficient for v1.9. NetworkPolicy is defence-in-depth that is only worth the operational complexity if evidence warrants.
- **Image-publish CI job** — ECR push currently manual; add a GitHub Actions job that runs on `staging` merges to rebuild and push `:staging-latest`.
- **Prod rollout and secret rotation** — Phase 39.
- **`SidecarContainers` feature gate probe, IMDS hop-limit probe, ExternalSecrets `refreshInterval` inventory** — STATE.md flags these as Phase 37 pre-execution probes; actually operator-only runtime checks, record results in PROJECT.md Key Decisions during step 3 smoke.

## Verification

- `python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['deploy/keeperhub-sandbox/staging/values.yaml','deploy/keeperhub-sandbox/staging/sa.yaml','deploy/keeperhub-sandbox/staging/pod-automount-patch.yaml','deploy/keeperhub/staging/values.yaml']]"` — all pass.
- `pnpm type-check` — clean (no regression).
- `grep -c 'eks.amazonaws.com/role-arn' deploy/keeperhub-sandbox/staging/` — 0 (anti-assertion: no IRSA leak).
- `grep -c 'automountServiceAccountToken: false' deploy/keeperhub-sandbox/staging/` — 2 (SA + Pod).
- `grep -c 'SANDBOX_BACKEND' deploy/keeperhub/staging/values.yaml` — 1 (main-app flip).

## Commits

- `feat(38): staging deploy manifests + escape-matrix E2E scaffold`

## Why phase status is `artifacts_ready` not `complete`

Phase 38 success criteria 1-3 require live cluster queries (`kubectl get pods`, `kubectl exec`, running E2E tests against staging). Those cannot be verified from the dev session. Success criteria 4 (E2E against Code-node workflow) and 5 (24-hour soak) are similarly operator-gated. All authoring deliverables are complete; the phase flips to `complete` when the operator confirms the runbook passed.
