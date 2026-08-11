# K8s Job Architecture Quick Reference

Quick reference for how Kubernetes Jobs execute scheduled workflows.

## Architecture

```
Dispatcher (CronJob) → SQS Queue → Job Spawner (Deployment) → K8s Job (Runner)
     ↓                    ↓              ↓                        ↓
Runs every minute    Buffers msgs    Creates Jobs          Executes workflow
Checks schedules     Provides DLQ    Per message           in isolation
```

## Execution Flow

1. **Dispatcher CronJob** - Runs every minute, queries due schedules, sends to SQS
2. **Job Spawner** - Polls SQS, creates execution record, spawns K8s Job
3. **K8s Job** - Runner container executes workflow steps, updates DB status
4. **Cleanup** - K8s auto-removes Job after TTL (1 hour)

## K8s Job Configuration

| Setting | Value | Purpose |
|---------|-------|---------|
| `ttlSecondsAfterFinished` | 3600 | Auto-cleanup after 1 hour |
| `backoffLimit` | 0 | No K8s retries (app handles) |
| `activeDeadlineSeconds` | 300 | 5 minute timeout |
| `restartPolicy` | Never | Don't restart failed containers |

## Resource Limits

```yaml
resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "512Mi"
    cpu: "500m"
```

## Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `WORKFLOW_ID` | Job Spawner | Which workflow to run |
| `EXECUTION_ID` | Job Spawner | Tracking ID |
| `WORKFLOW_INPUT` | Job Spawner | JSON input data |
| `DATABASE_URL` | K8s Secret | DB connection |
| `INTEGRATION_ENCRYPTION_KEY` | K8s Secret | Decrypt credentials |

## Why SQS?

- **Decoupling** - Dispatcher doesn't wait for job creation
- **Buffering** - Messages queue if K8s API is slow
- **Retry** - Failed job creations can retry
- **DLQ** - Captures persistent failures for debugging

## Key Files

| File | Purpose |
|------|---------|
| `keeperhub-executor/index.ts` | Polls SQS, creates K8s Jobs |
| `keeperhub-executor/workflow-runner.ts` | Executes workflow in Job pod |
| `deploy/local/workflow-runner-job.yaml` | Job template |

## Commands

```bash
# Check running jobs
kubectl get jobs -n local -l app=workflow-runner

# Job logs
kubectl logs -n local job/workflow-exec-<execution-id>

# Clean up stuck jobs
kubectl delete jobs -n local -l app=workflow-runner --field-selector status.successful=0
```

## Related Docs

- [workflow-execution-runtime.md](workflow-execution-runtime.md) - Full architecture
- [schedule-trigger.md](schedule-trigger.md) - Schedule trigger MVP
