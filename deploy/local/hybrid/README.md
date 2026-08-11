# Hybrid Development Mode

Run most services in Docker Compose with only the schedule executor in Minikube. The executor polls SQS and executes workflows via the KeeperHub API.

## Why Hybrid Mode?

| Mode                            | Memory | Workflow Execution    | Best For                    |
| ------------------------------- | ------ | --------------------- | --------------------------- |
| Docker Compose (`dev` profile)  | ~2-3GB | Direct (no isolation) | UI/API development          |
| Full Minikube                   | ~8GB   | K8s Jobs              | Production-like testing     |
| **Hybrid (`minikube` profile)** | ~4-5GB | K8s Jobs              | Workflow testing during dev |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Docker Compose (minikube profile)            │
├─────────────────────────────────────────────────────────────┤
│  app-dev  │  db  │  localstack  │  dispatcher  │  redis     │
│  (Next.js)│(Postgres)│  (SQS)  │  (cron loop) │            │
│           │          │          │  sc-event-*  │            │
└─────────────────────────────────────────────────────────────┘
          ▲                           │
          │ API call                  │ SQS message
          │ host.minikube.internal    ▼ host.minikube.internal
┌─────────────────────────────────────────────────────────────┐
│                    Minikube (minimal)                        │
├─────────────────────────────────────────────────────────────┤
│   (Deployment) - polls SQS, calls API      │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

For LocalStack SQS to work correctly in hybrid mode, add the following to your `/etc/hosts`:

```bash
echo "127.0.0.1 host.minikube.internal" | sudo tee -a /etc/hosts
```

This allows both the host and Minikube pods to resolve the same SQS queue URLs.

### LocalStack Auth Token

LocalStack requires an auth token. Add it to your `.env` file or export it:

```bash
export LOCALSTACK_AUTH_TOKEN="your-token-here"
```

Get a token from 1Password note called "localstack.cloud".

## Quick Start

**Option 1: One-command setup**

```bash
make hybrid-setup
```

**Option 2: Step-by-step**

```bash
# 1. Start Docker Compose services
docker compose --profile minikube up -d

# 2. Run database migrations
docker compose run --rm migrator

# 3. Start Minikube with minimal resources
minikube start --memory=4096 --cpus=2

# 4. Deploy scheduler to Minikube (builds and loads images)
./deploy/local/hybrid/deploy.sh --build

# 5. Access the application
#    App: http://localhost:3000
```

## Commands

### Start Hybrid Mode

```bash
# Start Docker Compose services
docker compose --profile minikube up -d

# Build images and deploy scheduler to Minikube
./deploy/local/hybrid/deploy.sh --build
```

### Check Status

```bash
./deploy/local/hybrid/deploy.sh --status
# or
make hybrid-status
```

### Teardown

```bash
# Remove scheduler from Minikube
./deploy/local/hybrid/deploy.sh --teardown

# Stop Docker Compose services
docker compose --profile minikube down
```

### View Executor Logs

```bash
kubectl logs -n local -l app=executor -f
```

## Switching Between Modes

### From dev to minikube profile

```bash
# Stop dev profile
docker compose --profile dev down

# Start minikube profile
docker compose --profile minikube up -d

# Deploy scheduler to Minikube
./deploy/local/hybrid/deploy.sh --build
```

### From minikube back to dev profile

```bash
# Remove scheduler from Minikube
./deploy/local/hybrid/deploy.sh --teardown

# Stop minikube profile
docker compose --profile minikube down

# Start dev profile (includes dispatcher and executor in Docker)
docker compose --profile dev up -d
```

## Troubleshooting

### Job-spawner can't connect to Docker Compose services

Verify `host.minikube.internal` resolves correctly:

```bash
minikube ssh -- ping -c 3 host.minikube.internal
```

If it fails, try restarting Minikube:

```bash
minikube stop && minikube start
```

### Executor not processing messages

Check executor logs:

```bash
kubectl logs -n local -l app=executor
```

Verify executor image is loaded:

```bash
minikube image ls | grep keeperhub-executor
```

### Database connection issues

Ensure PostgreSQL is accessible from Minikube:

```bash
minikube ssh -- nc -zv host.minikube.internal 5432
```

### SQS messages not being processed

Check LocalStack is healthy:

```bash
docker compose logs localstack
awslocal sqs list-queues
awslocal sqs get-queue-attributes --queue-url http://host.minikube.internal:4566/000000000000/keeperhub-workflow-queue --attribute-names All
```

## Files

| File                 | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `setup.sh`           | Full setup script (prerequisites, hosts, compose, minikube, scheduler) |
| `deploy.sh`          | Deployment helper script for scheduler components                      |
| `init-localstack.sh` | LocalStack initialization (creates SQS queue)                          |
| `README.md`          | This file                                                              |

## Comparison: dev vs minikube Profile

| Component | `dev` Profile | `minikube` Profile |
|-----------|--------------|-------------------|
| db | Docker Compose | Docker Compose |
| localstack | Docker Compose | Docker Compose |
| redis | Docker Compose | Docker Compose |
| app-dev | Docker Compose | Docker Compose |
| dispatcher | Docker Compose (loop) | Docker Compose (loop) |
| block-dispatcher | Docker Compose | Docker Compose |
| event-tracker | Docker Compose | Docker Compose |
| executor | Docker Compose | Minikube Deployment |

In both profiles, dispatchers run in Docker Compose and send triggers to SQS.
In `dev` profile, the executor runs in Docker Compose (in-process execution).
In `minikube` profile, the executor runs in Minikube with K8s Job isolation.

## Testing

### Run Workflow Runner E2E Tests

The workflow runner tests require PostgreSQL to be running (port 5433):

```bash
# Start dev profile (or minikube profile) to get PostgreSQL running
make dev-up

# Run the workflow runner tests
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/keeperhub" \
  pnpm test -- --run tests/e2e/workflow-runner.test.ts
```

### Manual Workflow Runner Testing

Test the workflow runner directly without K8s:

```bash
# Create a test execution in the database first, then:
WORKFLOW_ID=<workflow-id> \
EXECUTION_ID=<execution-id> \
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/keeperhub" \
  tsx keeperhub-executor/workflow-runner-bootstrap.ts
```

### Test in Docker Container

```bash
# Build the runner image
docker build --target workflow-runner -t keeperhub-runner:latest .

# Run workflow in container
docker run --rm --network host \
  -e WORKFLOW_ID=<workflow-id> \
  -e EXECUTION_ID=<execution-id> \
  -e DATABASE_URL="postgresql://postgres:postgres@localhost:5433/keeperhub" \
  keeperhub-runner:latest
```
