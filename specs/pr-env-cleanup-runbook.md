# PR Environment Cleanup Runbook

## Why namespaces go stale

`deploy-pr-environment.yaml` is triggered by `pull_request` events including `synchronize` (new push). Image builds take 10-15 minutes. During that window:

1. Engineer pushes a commit → deploy workflow starts, begins building images.
2. PR is merged → `cleanup-pr-environment.yaml` fires, finds the existing namespace, and deletes it.
3. The deploy job starts (after images finish) — now running post-merge. It re-creates the namespace, deploys infra, runs Helm.
4. The deploy succeeds or fails. Either way, the namespace is now orphaned: the `closed` event already fired, so no future cleanup will ever trigger.

## How to find orphaned namespaces

```bash
kubectl get namespaces | grep '^pr-'

# Cross-reference with GitHub to find which are truly orphaned
for ns in $(kubectl get namespaces -o name | grep 'namespace/pr-' | sed 's|namespace/||'); do
  pr="${ns#pr-}"
  state=$(gh pr view "$pr" --repo KeeperHub/keeperhub --json state --jq '.state' 2>/dev/null || echo NOT_FOUND)
  echo "$ns  PR #$pr  $state"
done
```

Namespaces whose PR is `MERGED` or `CLOSED` are orphaned and safe to delete. Namespaces whose PR is `OPEN` should be left alone.

## Manual cleanup procedure

Run this for each stale namespace. Replace `$NS` with the namespace to clean (e.g. `pr-1234`).

```bash
NS=pr-1234

# 1. Uninstall Helm releases (lets controllers clean up owned CRDs/PVCs)
for release in $(helm list -n "$NS" -q); do
  helm uninstall "$release" -n "$NS" --wait --timeout 5m --no-hooks || true
done

# 2. Delete the CNPG cluster (it holds a finalizer; must go before the namespace)
kubectl delete cluster "keeperhub-${NS}-db" -n "$NS" --wait=false 2>/dev/null || true

# 3. Delete the namespace
kubectl delete namespace "$NS" --timeout=10m

# If that times out (stuck finalizer from CNPG or another operator):
kubectl patch namespace "$NS" -p '{"metadata":{"finalizers":[]}}' --type=merge
```

### Bulk cleanup of multiple stale namespaces

Use the cross-reference loop above to identify orphaned namespaces, then run:

```bash
for NS in pr-111 pr-222 pr-333; do   # replace with actual orphaned namespaces
  echo "=== cleaning $NS ==="
  for release in $(helm list -n "$NS" -q 2>/dev/null || true); do
    helm uninstall "$release" -n "$NS" --wait --timeout 5m --no-hooks || true
  done
  kubectl delete cluster "keeperhub-${NS}-db" -n "$NS" --wait=false 2>/dev/null || true
  kubectl delete namespace "$NS" --timeout=10m || \
    kubectl patch namespace "$NS" -p '{"metadata":{"finalizers":[]}}' --type=merge
done
```

Always verify each namespace's PR state before adding it to the list — never delete a namespace for an open PR.

## Automated safeguards

Two safeguards prevent future accumulation:

### 1. `check-pr-state` gate in `deploy-pr-environment.yaml`

A `check-pr-state` job runs after all image builds complete. It calls `gh pr view` to get the current PR state. If the PR is no longer `OPEN`, the deploy job is skipped. The check runs at the last possible moment (after the 10-15 min image build window where the race occurs).

### 2. `scheduled-cleanup-pr-environments.yaml`

A nightly cron at 03:00 UTC scans all `pr-*` namespaces, checks each PR's state via the GitHub API, and deletes namespaces for closed/merged PRs. This catches any edge cases the primary guard misses.

You can also trigger it manually with dry-run mode to inspect the current state:

```
GitHub → Actions → "Scheduled PR Environment Cleanup" → Run workflow → dry_run: true
```
