# Sandbox Escape-Matrix E2E Tests (v1.9)

These tests prove that an escape from the KeeperHub Code action node — running inside the dedicated `keeperhub-sandbox-{env}` Pod — cannot read secrets from the main `keeperhub-{env}` Pod.

## Threat model recap

The Code action node runs user-supplied JavaScript. `node:vm.runInContext` is NOT a cryptographic sandbox (native constructors leak the host prototype chain; `Error.constructor("return process")()` reaches `process`). The v1.9 defence is:

1. **Separate Pod** (`keeperhub-sandbox-{env}`, different PID namespace) — closes `/proc/<main-pid>/environ`.
2. **Scrubbed env (CHILD_ENV_ALLOWLIST)** — closes `process.env` even inside the sandbox.
3. **Dedicated ServiceAccount with no RoleBindings and `automountServiceAccountToken: false` at SA + Pod level** — closes `/var/run/secrets/kubernetes.io/serviceaccount/token`.
4. **No `eks.amazonaws.com/role-arn` IRSA annotation on the SA** — closes `/var/run/secrets/eks.amazonaws.com/serviceaccount/token`.
5. **Distroless runtime image, readOnlyRootFilesystem, dropped capabilities, seccomp RuntimeDefault** — closes the "spawn a shell and pivot" and "drop an ELF in /etc and re-exec" pathways.
6. **NetworkPolicy egress-deny with kube-dns + public 443 allowlist** — closes in-cluster lateral movement (postgres, redis, main app) and direct IMDS reach.

The TEST-01..05 cases assert the env / SA / IRSA strand. The TEST-06..10 cases (added with the Tier 1 hardening) assert the image / FS / network strand.

## Running against staging

### Prerequisites

- `kubectl` context pointed at `maker-staging` with read access to `keeperhub` namespace.
- AWS credentials exported (for EKS token exchange).
- The staging sandbox release is deployed (see `deploy/keeperhub-sandbox/staging/`).
- A `STAGING_API_TOKEN` with permission to create + execute workflows.
- `SANDBOX_BACKEND=remote` is set in the main `keeperhub-staging` Deployment env (see the `app` component in `deploy/keeperhub-stack/staging/values.yaml`).

### One-time planted sentinel

Before running the E2E suite, plant a sentinel value in the main pod's env so the tests can assert it is NOT reachable from inside the sandbox. Operators do this via the Parameter Store + ExternalSecrets refresh:

```bash
# Write a test-only sentinel to SSM (staging only — never in prod).
aws ssm put-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary \
  --type SecureString \
  --value "KH_ESCAPE_CANARY_$(openssl rand -hex 8)" \
  --overwrite

# Add it to the app component shared_env in
# deploy/keeperhub-stack/staging/values.yaml as KH_ESCAPE_CANARY_VALUE
# (parameterStore type), then helm upgrade to
# propagate. DO NOT commit the sentinel value.

# Capture the sentinel locally for the test runner:
export EXPECTED_SENTINEL=$(aws ssm get-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary \
  --with-decryption --query Parameter.Value --output text)
```

### Run

```bash
STAGING_URL=https://staging.keeperhub.com \
STAGING_API_TOKEN=<token> \
EXPECTED_SENTINEL=<value planted above> \
  pnpm exec vitest run tests/e2e/sandbox-escape/escape-matrix.spec.ts
```

The suite runs five tests (TEST-01..05). Each builds a Code workflow with a specific escape payload via the REST API, executes it against staging (which routes to the remote sandbox because `SANDBOX_BACKEND=remote`), and asserts the output does NOT contain `EXPECTED_SENTINEL`.

### Cleanup

```bash
aws ssm delete-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary
# Revert values.yaml to remove KH_ESCAPE_CANARY_VALUE, helm upgrade again.
```

## Running against local minikube

If `make setup-local-kubernetes` has installed minikube (see `deploy/local/README.md`), apply the staging manifests against the local cluster:

```bash
helm upgrade --install keeperhub-sandbox \
  techops-services/common \
  --namespace keeperhub \
  -f deploy/keeperhub-sandbox/staging/values.yaml

kubectl apply -f deploy/keeperhub-sandbox/staging/sa.yaml

kubectl -n keeperhub patch deployment keeperhub-sandbox-common \
  --patch-file deploy/keeperhub-sandbox/staging/pod-hardening-patch.yaml

kubectl apply -f deploy/keeperhub-sandbox/staging/networkpolicy.yaml

# Plant a local canary directly in the main app Deployment:
kubectl -n keeperhub set env deployment/keeperhub-staging \
  KH_ESCAPE_CANARY_VALUE=KH_ESCAPE_CANARY_$(openssl rand -hex 8)
```

Then run the same `pnpm exec vitest run tests/e2e/sandbox-escape/...` with the minikube tunnel URL.

## Test matrix

| ID | Payload | Assertion |
|----|---------|-----------|
| TEST-01 | `Error.constructor("return process")(); return JSON.stringify(Object.keys(process.env))` | Sandbox returns JS surface but `Object.keys(process.env)` is the CHILD_ENV_ALLOWLIST only (no sentinel). |
| TEST-02 | `const p = Error.constructor("return process")(); return p.mainModule.require("fs").readFileSync("/proc/self/environ", "utf8")` | Returned environ string does NOT contain the sentinel (scrubbed via execve). |
| TEST-03 | Read `/proc/1/environ` and `/proc/<ppid>/environ` | Both return ENOENT or do not contain the sentinel (separate PID namespace). |
| TEST-04 | Read `/var/run/secrets/kubernetes.io/serviceaccount/token` | Returns ENOENT (`automountServiceAccountToken: false`). |
| TEST-05 | Read `/var/run/secrets/eks.amazonaws.com/serviceaccount/token` | Returns ENOENT (no IRSA annotation on SA). |
| TEST-06 | `child_process.spawn` of `/bin/sh`, `/bin/bash`, `/bin/ash`, `/bin/busybox`, `/usr/bin/sh` | All spawns fail with ENOENT/EACCES/EPERM (distroless image carries only `/nodejs/bin/node`). |
| TEST-07 | `fs.writeFileSync` to `/etc/...`, `/usr/...`, `/...` plus a sanity write to `/tmp` | Outside-/tmp writes fail with EROFS/EACCES; `/tmp` write succeeds (proves the tmpfs is mounted). |
| TEST-08 | Raw TCP via `require("net")` to postgres, redis, and the main app ClusterIPs | All connects fail (NetworkPolicy egress denies in-cluster traffic). |
| TEST-09 | Raw TCP via `require("net")` to `169.254.169.254:80` | Connect fails (NP excludes `169.254.0.0/16` from the public-IP allow). |
| TEST-10 | Raw TCP via `require("net")` to `10.0.0.1:443`, `172.16.0.1:443`, `192.168.0.1:443` | All connects fail (NP excludes RFC1918 from the public-IP allow). |

## Failure triage

- **TEST-01 fails (sentinel found in process.env):** The main-app Deployment's env is leaking into the sandbox Pod — likely a values.yaml misconfiguration that added shared_env to the sandbox release, or a `shareProcessNamespace: true` somewhere. Check `kubectl describe pod keeperhub-sandbox-...`.
- **TEST-02 fails (sentinel in `/proc/self/environ`):** CHILD_ENV_ALLOWLIST was augmented with a non-allowlisted var, OR the sandbox is running as PID 1 inside the Pod without the child_process wrapper. Verify `plugins/code/steps/run-code.ts` still uses spawn + buildChildEnv.
- **TEST-03 fails:** Two Pods are in the same PID namespace (`shareProcessNamespace`). Banned by cluster admission policy; if this fails the fix is a k8s audit, not a code change.
- **TEST-04 fails:** `automountServiceAccountToken: false` is missing from either the SA or the Pod spec. Check both `sa.yaml` and the `pod-hardening-patch.yaml` were applied.
- **TEST-05 fails:** The `eks.amazonaws.com/role-arn` annotation slipped onto the sandbox SA. CI grep-check in pr-checks.yml should have caught this pre-merge.
- **TEST-06 fails (a shell spawned):** The runtime image is no longer distroless. Check `sandbox/Dockerfile` runtime stage and the digest pin. Most likely cause: a Dockerfile rebase that reverted to `node:24-alpine` for debugging and was not unrebased.
- **TEST-07 fails (write outside /tmp succeeded):** `readOnlyRootFilesystem: true` is missing from `securityContext` in `values.yaml`. The chart wires `securityContext` into the container directly; check rendered output.
- **TEST-08 fails (in-cluster reach succeeded):** The NetworkPolicy is not applied, the VPC CNI agent is not enforcing it, or the policy's `podSelector` does not match the sandbox Pod's labels. Check `kubectl -n keeperhub get networkpolicy keeperhub-sandbox` and `kubectl -n keeperhub describe networkpolicy keeperhub-sandbox`. Confirm `app.kubernetes.io/instance: keeperhub-sandbox` is on the Pod (it is set by the chart but a label rename would break the policy).
- **TEST-09 fails (IMDS reachable):** Same as TEST-08 plus the node-level IMDS hop-limit on the underlying node group. Even without a NetworkPolicy, hop-limit=1 should block container-origin requests; current cluster default is hop-limit=2 (Tier 1e narrows the sandbox NodePool to hop-limit=1 separately).
- **TEST-10 fails (RFC1918 reachable on 443):** The NetworkPolicy's `ipBlock.except` list is missing entries or the policy was replaced with a more permissive variant. Inspect `kubectl -n keeperhub get networkpolicy keeperhub-sandbox -o yaml`.
