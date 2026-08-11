# Phase 39: Prod Rollout + Retire In-Pod Path + Rotate High-Value Secrets - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Mirror Phase 38's staging deploy to prod, verify the escape matrix in prod, retire the in-pod `child_process` path from the main app after 7 days of prod stability, and rotate the high-value secrets that were exposed before the fix landed (one secret at a time, ESO force-sync + rollout restart + verification between each).

In scope:
- `deploy/keeperhub-sandbox/prod/` mirror of the staging manifests.
- `deploy/keeperhub/prod/values.yaml` flip to `SANDBOX_BACKEND=remote`.
- Re-running the escape-matrix E2E scaffolding against prod (read-only payloads only).
- A retirement PR that removes `runLocal` from `plugins/code/steps/run-code.ts` and collapses `stepHandler` to always call `runRemote` (kept behind a minimal local-dev escape hatch or removed entirely per the roadmap success criterion 3).
- A per-secret rotation runbook with 11 rotation steps.

Out of scope: NetworkPolicy (deferred from Phase 38), metrics/alerting (post-v1.9), multi-region prod failover.
</domain>

<decisions>
## Implementation Decisions

### Prod deploy layout
- Copy `deploy/keeperhub-sandbox/staging/` → `deploy/keeperhub-sandbox/prod/`.
- Change service/release name `-staging` → `-prod` and SSM parameter prefix `techops-staging` → `techops-prod`.
- Prod SANDBOX_URL: `http://keeperhub-sandbox-prod.keeperhub.svc.cluster.local:8787`.
- Prod image tag: `prod-YYYYMMDD` (date-stamped for audit trail) or the SHA-pinned tag from the staging-proven image.
- Prod `replicaCount: 2` (vs staging 1) for HA.

### Escape-matrix in prod
- Reuse `tests/e2e/sandbox-escape/escape-matrix.spec.ts` with `STAGING_URL=https://app.keeperhub.com`.
- ONLY the five read-only payloads (process.env, /proc/self/environ, /proc/1/environ, token files) — no destructive or mutating probes.
- Runs once during initial prod rollout; no scheduled re-run (the chain's job is to catch drift; ongoing CI is the `test-unit-sandbox-remote` job which runs on every PR).

### In-pod path retirement
- After 7 days of clean prod operation (no incidents, no Code-node error rate regression vs pre-rollout baseline), open a retirement PR.
- Retirement PR scope: delete `runLocal()`, `runInChild()`, `CHILD_SOURCE`, `CHILD_ENV_ALLOWLIST`, `buildChildEnv()`, `parseChildOutput()` from `plugins/code/steps/run-code.ts`. Keep `validateInput()` and the selector but collapse dispatcher to always `runRemote`. The local-dev `SANDBOX_BACKEND=local` path is removed; local dev uses `pnpm dev:sandbox` + `SANDBOX_BACKEND=remote + SANDBOX_URL=http://localhost:8787`.
- Delete the `test-unit` local-backend run of `tests/unit/code-run-code.test.ts` — the `test-unit-sandbox-remote` CI job becomes the only gate. Tests are adjusted (remove any that depend on local-backend-only internals such as the Linux-only `/proc/self/environ` helper gate).
- OR: Soft retirement alternative — keep `runLocal` only behind a `__KEEPERHUB_FORCE_LOCAL_SANDBOX=1` unit-test-only escape hatch, clearly documented as not-for-production. Chooses based on whether the team wants a single code path or a belt-and-braces fallback during the transition. Default per roadmap: hard removal; keep local path only for local dev via the docker-compose container, not via the in-pod child_process.

### Secret rotation
- 11 secrets in rotation order:
  1. `AGENTIC_WALLET_HMAC_KMS_KEY` — **respect 8-newest-version grace window** (a93ce4b9-era commit `ef2bebd0 chore(agentic-wallet): bound listActiveHmacSecrets at 8 newest versions`). Add new key version; verify HMAC signatures validate against both old and new; remove oldest after 8-version window elapses.
  2. `WALLET_ENCRYPTION_KEY`
  3. `INTEGRATION_ENCRYPTION_KEY`
  4. `TURNKEY_API_PRIVATE_KEY`
  5. `DATABASE_URL` password (rotate the password, not the host)
  6. `BETTER_AUTH_SECRET`
  7. `OAUTH_JWT_SECRET`
  8. `STRIPE_SECRET_KEY`
  9. `GITHUB_CLIENT_SECRET`
  10. `GOOGLE_CLIENT_SECRET`
  11. `CDP_API_KEY_SECRET`
- Per-secret cycle: (a) generate new value via provider (`aws kms rotate-key-manually` for KMS; provider dashboards for others); (b) update AWS Parameter Store SSM value; (c) `kubectl annotate externalsecret ... force-sync="$(date)"` to accelerate ESO refresh; (d) `kubectl rollout restart deployment/keeperhub-prod`; (e) in-pod verification (`kubectl exec ... printenv | grep <NAME>` or an HTTP health check that exercises the secret); (f) 30-minute soak before next secret.
- Serialize rotations — NEVER two secrets in parallel (surface blast-radius isolation).

### KEEP-332 closure
- After all 11 secrets are rotated and the retirement PR has merged, post a summary to KEEP-332 with links to each rotation's PR, the staging/prod escape-matrix results, and the retirement PR. Close with resolution `Fixed`.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `deploy/keeperhub/prod/values.yaml` + `rbac.yaml` — prod Helm configuration uses identical structure to staging with `/eks/techops-prod/...` parameter prefixes.
- `deploy/keeperhub-sandbox/staging/` (Phase 38) — directly mirror-able to prod by substituting `-staging` → `-prod` and parameter paths.
- ExternalSecrets (ESO) — already wired for the staging/prod main-app releases; the sandbox release has no secrets (intentionally) so this is main-app only.
- `scripts/miscellaneous/rotate-secret.ts` (if present) or ad-hoc runbook scripts.
- `git log --oneline --grep KEEP` — history of KEEP-issue-referenced commits for the rotation PRs to reference.

### Established Patterns
- Rotation uses SSM parameter update → ESO sync → rollout restart → verify.
- Rotation PRs reference the KEEP issue and carry a test-plan checklist.
- ESO force-sync annotation: `force-sync: "<ISO timestamp>"`.

### Integration Points
- `deploy/keeperhub/prod/values.yaml` env block gains SANDBOX_BACKEND/SANDBOX_URL (identical pattern to staging Phase 38).
- `plugins/code/steps/run-code.ts` retirement removes ~350 lines.
- `tests/unit/code-run-code.test.ts` loses its local-backend dependency; tests run exclusively against the remote sandbox (the existing `test-unit-sandbox-remote` CI job becomes the sole gate for that file).

</code_context>

<specifics>
## Specific Ideas

- Use `sed -i '' 's/staging/prod/g' deploy/keeperhub-sandbox/prod/*.yaml` as a starting point for the mirror, then hand-audit for SSM path prefix + IRSA-adjacent details.
- For the retirement PR, the diff is almost entirely `-` in `plugins/code/steps/run-code.ts` + some test adjustments. Keep `validateInput` and the module-level `SANDBOX_BACKEND = process.env.SANDBOX_BACKEND ?? "remote"` const (default flipped to `remote`). Delete `runLocal`, `runInChild`, `CHILD_SOURCE`, `parseChildOutput`, `buildChildEnv`.
- For the agentic-wallet HMAC rotation, consult commit `ef2bebd0` which clamped `listActiveHmacSecrets` at 8 newest versions — do NOT rotate faster than that window allows (would orphan in-flight signatures).

</specifics>

<deferred>
## Deferred Ideas

- **Multi-region prod failover** — not a v1.9 scope item.
- **`isolated-vm` defence-in-depth** — explicitly rejected for v1.9.
- **Admission policies banning IRSA / hostNetwork / shareProcessNamespace cluster-wide** — optional hardening, out of v1.9 scope.
- **NetworkPolicy for the sandbox Pod** — still deferred; Phase 39 does NOT add it. If the 7-day prod soak produces evidence that the SA scrub is insufficient, a v1.9.1 can add NetworkPolicy + VPC CNI `enableNetworkPolicy=true` terraform flip.
- **Audit log for every Code-node invocation** — post-v1.9 per REQUIREMENTS.md.

</deferred>
