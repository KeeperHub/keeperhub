# Schedule Trigger Implementation

This document describes the schedule trigger feature for KeeperHub, which enables workflows to run automatically on a cron schedule.

## Architecture Overview

KeeperHub supports multiple deployment modes for workflow execution:

### Mode 1: Dev Mode (No K8s Jobs)

Direct execution via API - suitable for UI/API development:

```
┌─────────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Dispatcher    │────▶│  SQS Queue  │────▶│    Executor      │
│   (Docker)      │     │ (LocalStack)│     │    (Docker)      │
└─────────────────┘     └─────────────┘     └──────────────────┘
        │                                            │
        ▼                                            ▼
┌─────────────────┐                         ┌──────────────────┐
│   PostgreSQL    │                         │   KeeperHub API  │
│   (Docker)      │                         │ /api/workflow/   │
└─────────────────┘                         │ {id}/execute     │
                                            └──────────────────┘
```

### Mode 2: Hybrid Mode (Docker + Minikube K8s Jobs)

Isolated workflow execution in K8s Jobs - suitable for workflow testing:

```
┌───────────────────────────────────────────────────┐
│            Docker Compose (minikube profile)       │
│  ┌─────────┐  ┌───────────┐  ┌──────────────┐    │
│  │   db    │  │ localstack│  │   app-dev    │    │
│  │(Postgres)│  │   (SQS)   │  │  (Next.js)   │    │
│  └─────────┘  └───────────┘  └──────────────┘    │
└───────────────────────────────────────────────────┘
                        │ host.minikube.internal
                        ▼
┌───────────────────────────────────────────────────┐
│                    Minikube                        │
│  ┌──────────────┐      ┌──────────────────────┐  │
│  │  Dispatcher  │─SQS─▶│    Job Spawner       │  │
│  │  (CronJob)   │      │   (Deployment)       │  │
│  └──────────────┘      └──────────────────────┘  │
│                                │                  │
│                                ▼ creates          │
│                        ┌──────────────────────┐  │
│                        │   Workflow Runner    │  │
│                        │     (K8s Jobs)       │  │
│                        └──────────────────────┘  │
└───────────────────────────────────────────────────┘
```

### Mode 3: Full Kubernetes

All services in Minikube - suitable for production-like testing (~8GB RAM).

## Components

1. **Schedule Dispatcher** (`scripts/scheduler/schedule-dispatcher.ts`)
   - Runs as a Kubernetes CronJob (hybrid/k8s) or Docker loop (dev)
   - Queries `workflow_schedules` table for schedules due to run
   - Sends messages to SQS queue for each triggered schedule
   - Updates `next_run_at` and `last_run_at` timestamps

2. **Schedule Executor** (`scripts/scheduler/.ts`) - Dev Mode Only
   - Runs as a Docker container in dev profile
   - Polls SQS queue for workflow trigger messages
   - Calls KeeperHub API to execute workflows directly
   - Handles retries and error logging

3. **Job Spawner** (`keeperhub-executor/index.ts`) - Hybrid/K8s Mode
   - Runs as a Kubernetes Deployment
   - Polls SQS queue for workflow trigger messages
   - Creates K8s Jobs for each workflow execution
   - Provides isolated execution environment

4. **Workflow Runner** (`keeperhub-executor/workflow-runner.ts`) - Hybrid/K8s Mode
   - Runs inside K8s Jobs (one per workflow execution)
   - Executes workflow steps in isolation
   - Updates execution status in database

5. **SQS Queue** (LocalStack in local dev, AWS in production)
   - Decouples dispatcher from executor/job-spawner
   - Provides message durability and retry capabilities
   - Queue name: `keeperhub-workflow-queue`

## Database Schema

```sql
CREATE TABLE workflow_schedules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMP,
  last_run_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

## Local Development

KeeperHub provides three deployment modes with increasing resource requirements:

| Mode | Command | RAM | K8s Jobs | Best For |
|------|---------|-----|----------|----------|
| **Dev** | `make dev-up` | ~2-3GB | No | UI/API development |
| **Hybrid** | `make hybrid-setup` | ~4-5GB | Yes | Workflow testing |
| **Full K8s** | `make setup-local-kubernetes` | ~8GB | Yes | Production-like |

### Dev Mode (Recommended for Most Development)

All services run in Docker Compose. Workflows execute directly via API calls.

```bash
# Start everything
make dev-up

# Run migrations
make dev-migrate

# View logs
make dev-logs

# Stop
make dev-down
```

Access: http://localhost:3000

### Hybrid Mode (Recommended for Workflow Testing)

Docker Compose for infrastructure + Minikube for workflow execution.

```bash
# One-command setup (handles everything)
make hybrid-setup

# Or step-by-step:
docker compose --profile minikube up -d  # Start Docker services
make hybrid-deploy                        # Deploy scheduler to Minikube

# Check status
make hybrid-status

# View job-spawner logs
make hybrid-logs

# View workflow runner logs
make hybrid-runner-logs

# Teardown
make hybrid-down
```

**Prerequisites for Hybrid Mode:**

```bash
# Add to /etc/hosts (required for SQS URL resolution)
echo "127.0.0.1 host.minikube.internal" | sudo tee -a /etc/hosts
```

Access: http://localhost:3000

### Full Kubernetes Mode

All services run in Minikube.

```bash
# Setup infrastructure
make setup-local-kubernetes

# Deploy KeeperHub
make deploy-to-local-kubernetes

# Deploy scheduler
make build-scheduler-images
make deploy-scheduler

# Check status
make scheduler-status

# View logs
make scheduler-logs

# Teardown
make teardown
```

### Makefile Commands

| Command | Description |
|---------|-------------|
| **Dev Mode** ||
| `make dev-up` | Start dev profile (db, app, dispatcher, executor) |
| `make dev-down` | Stop dev profile |
| `make dev-logs` | Follow dev profile logs |
| `make dev-migrate` | Run database migrations |
| **Hybrid Mode** ||
| `make hybrid-setup` | Full hybrid setup (one command) |
| `make hybrid-up` | Start Docker Compose services |
| `make hybrid-deploy` | Build and deploy scheduler to Minikube |
| `make hybrid-status` | Show hybrid deployment status |
| `make hybrid-down` | Teardown hybrid deployment |
| `make hybrid-logs` | Follow job-spawner logs |
| `make hybrid-runner-logs` | Show workflow runner logs |
| **Full K8s Mode** ||
| `make deploy-scheduler` | Deploy scheduler to Minikube |
| `make scheduler-status` | Show scheduler pods and job status |
| `make scheduler-logs` | Follow scheduler logs |
| `make teardown-scheduler` | Remove scheduler components |

### Verify Hybrid Deployment

```bash
# Check status
make hybrid-status

# Expected output:
# === Docker Compose (minikube profile) ===
# NAME                  STATUS    PORTS
# keeperhub-db          running   0.0.0.0:5432->5432/tcp
# keeperhub-localstack  running   0.0.0.0:4566->4566/tcp
# keeperhub-app-dev     running   0.0.0.0:3000->3000/tcp
#
# === Schedule Dispatcher (CronJob) ===
# NAME                  SCHEDULE    ACTIVE
# schedule-dispatcher   * * * * *   0
#
# === Job Spawner ===
# NAME                  READY   STATUS
# job-spawner-xxx       1/1     Running
#
# === Workflow Runner Jobs ===
# (Jobs appear here when workflows execute)
```

### View Logs

```bash
# Job spawner logs (shows SQS polling and K8s Job creation)
make hybrid-logs

# Workflow runner logs (shows actual workflow execution)
make hybrid-runner-logs

# Docker Compose logs
docker compose --profile minikube logs -f
```

## Kubernetes Resources

### ConfigMap (`scheduler-env`)

Environment variables for scheduler components:

```yaml
AWS_ENDPOINT_URL: "http://localstack:4566"
AWS_REGION: "us-east-1"
AWS_ACCESS_KEY_ID: "test"
AWS_SECRET_ACCESS_KEY: "test"
SQS_QUEUE_URL: "http://localstack:4566/000000000000/keeperhub-workflow-queue"
KEEPERHUB_URL: "http://keeperhub-common:3000"
DATABASE_URL: "postgresql://local:local@postgresql:5432/keeperhub"
```

### CronJob (`schedule-dispatcher`)

- **Schedule**: `* * * * *` (every minute)
- **Concurrency Policy**: Forbid (prevents overlapping runs)
- **Image**: `keeperhub-scheduler:latest`

### Deployment (``)

- **Replicas**: 1
- **Image**: `keeperhub-scheduler:latest`
- **Liveness Probe**: Checks for running node process

## Docker Image

The scheduler uses a separate Docker build stage:

```dockerfile
# Build scheduler image
docker build --target scheduler -t keeperhub-scheduler:latest .
```

This stage includes:
- Node.js runtime with tsx
- `scripts/` directory (dispatcher and executor)
- `lib/` directory (shared code)
- `node_modules/` (dependencies)

## Testing

### Unit Tests

```bash
pnpm test -- --run tests/unit/schedule-dispatcher.test.ts
pnpm test -- --run tests/unit/.test.ts
```

### Integration Tests

```bash
pnpm test -- --run tests/integration/
```

### E2E Tests (against minikube)

```bash
make test-e2e
```

E2E tests verify:
- PostgreSQL connectivity
- LocalStack SQS connectivity
- Database schema (workflow_schedules table)
- SQS message send/receive

## Production Considerations

### AWS SQS Setup

1. Create SQS queue: `keeperhub-workflow-queue`
2. Configure dead-letter queue for failed messages
3. Set appropriate visibility timeout (30 seconds recommended)
4. Configure IAM permissions for dispatcher/executor

### Environment Variables (Production)

```yaml
AWS_REGION: "us-east-1"  # Your region
SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789/keeperhub-workflow-queue"
KEEPERHUB_URL: "https://workflow.keeperhub.com"
DATABASE_URL: "postgresql://user:pass@host:5432/keeperhub"
# Remove AWS_ENDPOINT_URL in production (uses real AWS)
```

### Scaling

- **Dispatcher**: Single instance (CronJob with Forbid policy)
- **Executor**: Can scale horizontally (multiple replicas polling same queue)

### Monitoring

- Monitor SQS queue depth for backlog
- Alert on executor pod restarts
- Track workflow execution latency
- Monitor dispatcher job failures

## Troubleshooting

### Dispatcher not running

```bash
# Check CronJob status
kubectl get cronjobs -n local

# Check recent jobs
kubectl get jobs -n local -l app=schedule-dispatcher

# Check job logs
kubectl logs -n local -l app=schedule-dispatcher --tail=100
```

### Executor not processing messages

```bash
# Check executor pod
kubectl get pods -n local -l app=

# Check logs
kubectl logs -n local -l app= -f

# Verify SQS queue has messages
kubectl exec -n local deploy/localstack -- awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/keeperhub-workflow-queue \
  --attribute-names ApproximateNumberOfMessages
```

### Image pull errors

```bash
# Verify image is loaded in minikube
minikube image list | grep keeperhub-scheduler

# Reload if missing
docker build --target scheduler -t keeperhub-scheduler:latest .
minikube image load keeperhub-scheduler:latest
```

## Execution Modes Comparison

### Dev Mode Limitations

In dev mode, workflow execution happens inside the KeeperHub API via direct API calls:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│    Executor     │────▶│   KeeperHub     │────▶│  Workflow runs inside       │
│  (SQS consumer) │     │   API Pod       │     │  the API request handler    │
└─────────────────┘     └─────────────────┘     └─────────────────────────────┘
```

| Issue | Impact |
|-------|--------|
| **Long-running workflows** | Block the API request, risk timeout |
| **Resource contention** | Workflow execution competes with API requests |
| **No isolation** | A failing workflow could affect API stability |
| **No independent scaling** | Can't scale workflow execution separately from API |

**Best for**: UI/API development, short-running workflows (< 30s)

### Hybrid Mode Benefits

In hybrid mode, workflows execute in isolated K8s Jobs:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│   Job Spawner   │────▶│   K8s Job API   │────▶│  Workflow runs in isolated  │
│  (SQS consumer) │     │                 │     │  container (workflow-runner) │
└─────────────────┘     └─────────────────┘     └─────────────────────────────┘
```

| Benefit | Description |
|---------|-------------|
| **Isolated execution** | Each workflow runs in its own container |
| **No API contention** | Workflows don't block API requests |
| **Resource limits** | Each Job has defined CPU/memory limits |
| **Automatic cleanup** | K8s automatically cleans up completed Jobs |
| **Independent scaling** | Job-spawner can scale separately from app |

**Best for**: Workflow testing, longer-running workflows, production-like behavior

### Production Considerations

For production, use the full K8s mode or hybrid mode with:
- Proper resource limits on workflow-runner Jobs
- Dead letter queue for failed workflows
- Monitoring on job-spawner and workflow execution
- TTL configuration for job cleanup

---

## Files Reference

| File | Purpose |
|------|---------|
| **Scripts** ||
| `scripts/scheduler/schedule-dispatcher.ts` | Dispatcher script (queries DB, sends to SQS) |
| `scripts/scheduler/.ts` | Executor script - dev mode (polls SQS, calls API) |
| `keeperhub-executor/index.ts` | Job spawner - hybrid/k8s mode (polls SQS, creates K8s Jobs) |
| `keeperhub-executor/workflow-runner.ts` | Workflow runner - runs inside K8s Jobs |
| **Services** ||
| `lib/schedule-service.ts` | Schedule management service |
| `lib/db/schema/workflow-schedules.ts` | Database schema |
| `lib/workflow-executor.workflow.ts` | Workflow execution logic |
| **Docker Compose** ||
| `docker-compose.yml` | Docker Compose with dev/minikube profiles |
| **Hybrid Mode** ||
| `deploy/local/hybrid/setup.sh` | Full hybrid setup script |
| `deploy/local/hybrid/deploy.sh` | Hybrid deployment helper |
| `deploy/local/hybrid/init-localstack.sh` | LocalStack SQS initialization |
| `deploy/local/hybrid/README.md` | Hybrid mode documentation |
| **Full K8s Mode** ||
| `deploy/local/schedule-trigger.yaml` | K8s manifests for scheduler (full k8s mode) |
| `deploy/local/setup-local.sh` | Minikube infrastructure setup |
| **Tests** ||
| `tests/unit/schedule-*.test.ts` | Unit tests |
| `tests/e2e/schedule-pipeline.test.ts` | E2E tests |
