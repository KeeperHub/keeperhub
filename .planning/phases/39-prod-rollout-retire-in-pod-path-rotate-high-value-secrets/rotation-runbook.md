# v1.9 Post-Deploy Secret Rotation Runbook

**Trigger:** 7 days after prod has been running cleanly on `SANDBOX_BACKEND=remote` and the in-pod child_process path has been retired.

**Reason:** The three exfil paths closed by v1.9 (`/proc/<main>/environ`, K8s SA token, IRSA token) were reachable from user JS before the fix landed. Assume-breach: any secret that was present in the main-pod env during the window between first external Code-node invocation and v1.9 merge MAY have been read by an attacker. Rotate one secret at a time to bound blast radius.

**Serialization rule:** Never rotate two secrets in parallel. 30-minute soak between each rotation. If anything looks wrong after a rotation (error rate up, auth failures, API call 500s), stop and diagnose before continuing.

---

## Per-secret cycle

Repeat for each secret in the list below, in the documented order:

### 1. Generate the new value

| Secret | How to generate |
|--------|-----------------|
| `AGENTIC_WALLET_HMAC_KMS_KEY` | Rotate KMS key version: `aws kms create-alias --alias-name alias/agentic-wallet-hmac-new --target-key-id <new-version>`. **IMPORTANT:** respect the 8-newest-version grace window (see commit `ef2bebd0 bound listActiveHmacSecrets at 8 newest versions`). Do NOT delete old versions for at least 8 * rotation-interval. |
| `WALLET_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `INTEGRATION_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `TURNKEY_API_PRIVATE_KEY` | Turnkey dashboard: rotate API credential. Capture new private key. |
| `DATABASE_URL` password | `aws rds modify-db-instance --db-instance-identifier <id> --master-user-password '<new>'`. Update DATABASE_URL accordingly. |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 48` |
| `OAUTH_JWT_SECRET` | `openssl rand -base64 48` |
| `STRIPE_SECRET_KEY` | Stripe Dashboard: API keys → Roll secret key. Capture new `sk_live_...`. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app settings: Generate new client secret. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console: OAuth 2.0 client → Reset secret. |
| `CDP_API_KEY_SECRET` | Coinbase Developer Platform dashboard: API key → Rotate. |

### 2. Write the new value to SSM Parameter Store (prod path)

```bash
aws ssm put-parameter \
  --name /eks/techops-prod/keeperhub/<parameter-name> \
  --type SecureString \
  --value "<NEW_VALUE>" \
  --overwrite
```

### 3. Force ExternalSecrets Operator refresh

ESO default refresh interval is 1 hour; accelerate with an annotation:

```bash
kubectl -n keeperhub annotate externalsecret keeperhub-prod \
  force-sync="$(date +%s)" --overwrite
```

Wait ~30 seconds. Verify the Secret object reflects the new data:

```bash
kubectl -n keeperhub get secret keeperhub-prod -o jsonpath="{.data.<PARAMETER_NAME>}" | base64 -d | head -c 20
# Compare against the first 20 chars of the new value you wrote to SSM.
```

### 4. Rollout restart the main app

```bash
kubectl -n keeperhub rollout restart deployment/keeperhub-prod
kubectl -n keeperhub rollout status deployment/keeperhub-prod --timeout=5m
```

### 5. Verify the new value is active in the running pod

```bash
POD=$(kubectl -n keeperhub get pods -l app.kubernetes.io/instance=keeperhub-prod \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n keeperhub exec "$POD" -- sh -c 'env | grep "^<PARAMETER_NAME>=" | cut -c1-30'
# Should show the NEW value prefix, not the old one.
```

Additionally, run a functional probe that exercises the secret. Examples:

- `DATABASE_URL` → `pnpm db:migrate --dry-run` or the nearest read-only probe that opens a DB connection.
- `STRIPE_SECRET_KEY` → smoke test a read API call via `https://<app>/api/billing/status`.
- `GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` → confirm OAuth login flow still works (manual).
- `BETTER_AUTH_SECRET` / `OAUTH_JWT_SECRET` → confirm a freshly-logged-in session still resolves (existing sessions may invalidate — expected for these rotations).
- `TURNKEY_API_PRIVATE_KEY` → sign a probe via the Turnkey SDK call in a test workflow.
- `WALLET_ENCRYPTION_KEY` / `INTEGRATION_ENCRYPTION_KEY` — re-encrypt pending records is a batch operation; see `scripts/rotate-encryption-key.ts` (if present) or run the one-time re-encryption job documented in the DB migration guide.
- `AGENTIC_WALLET_HMAC_KMS_KEY` — verify existing HMAC signatures still validate under the new key (grace window) AND new signatures verify under the new key. Existing-signature verification is the load-bearing check.
- `CDP_API_KEY_SECRET` — smoke test an onchain query via the CDP SQL API.

### 6. 30-minute soak

Do NOT start the next rotation for at least 30 minutes. Monitor:
- Sentry / error aggregator for new error types.
- `kubectl logs -l app.kubernetes.io/instance=keeperhub-prod -f` for spikes.
- `kubectl get pods -w` for any restart loops.

If anything suspicious surfaces, STOP. Do not proceed to the next rotation until you understand what happened.

### 7. Record in KEEP-332

Update KEEP-332 with a row in the rotation audit table:

| Secret | Rotated at (UTC) | SSM version | PR ref (if any) | Verified by |
|--------|------------------|-------------|-----------------|-------------|
| `<NAME>` | `YYYY-MM-DDTHH:MM:SSZ` | `<SSM version ID>` | `#<PR>` or `n/a` | `<rotator>` |

---

## Rotation order (ROT-01 requirement)

1. `AGENTIC_WALLET_HMAC_KMS_KEY` — highest-value, requires 8-version grace
2. `WALLET_ENCRYPTION_KEY`
3. `INTEGRATION_ENCRYPTION_KEY`
4. `TURNKEY_API_PRIVATE_KEY`
5. `DATABASE_URL` password
6. `BETTER_AUTH_SECRET`
7. `OAUTH_JWT_SECRET`
8. `STRIPE_SECRET_KEY`
9. `GITHUB_CLIENT_SECRET`
10. `GOOGLE_CLIENT_SECRET`
11. `CDP_API_KEY_SECRET`

Total wall-clock: ~11 secrets × (rotation time + 30min soak) ≈ 6-8 hours if nothing goes wrong. Budget a full day.

## Closing out

When all 11 rotations are green:
1. Post a summary to KEEP-332 linking the audit table rows, the retirement PR, and the Phase 38 + 39 escape-matrix runs.
2. Close KEEP-332 with resolution `Fixed`.
3. Update PROJECT.md `## Validated Requirements` block with `ROT-01` and `DEPLOY-02`.
4. Merge the milestone archive commit (handled by `/gsd-complete-milestone`).
