# KeeperHub Scheduler

Scheduler components for KeeperHub workflow execution. This service manages workflow triggering via cron-based schedules and blockchain block monitoring, then executes matched workflows via the KeeperHub API.

## Architecture

The scheduler is split into three separate services for better scalability and fault isolation:

```
KeeperHub API                                          KeeperHub API
     |                                                      ^
     | GET /api/internal/schedules                          | POST /api/workflow/{id}/execute
     v                                                      |
+--------------------+                                +---------------------+
| Schedule Dispatcher| ---+                      +--> | Workflow Executor    |
| (runs every 60s)   |   |                      |    | (continuous polling) |
+--------------------+   |    +------------+     |    +---------------------+
                         +--> | SQS Queue  | ----+
+--------------------+   |    +------------+
| Block Dispatcher   | --+
| (WebSocket monitor)|
+--------------------+
     ^
     | WSS connections
  Blockchain nodes
```

### Schedule Dispatcher

**Location:** `schedule-dispatcher/`

Evaluates cron schedules and queues workflows for execution.

- Runs on a 60-second interval
- Fetches enabled workflow schedules from KeeperHub API
- Evaluates each schedule's cron expression against current time
- Sends matching schedules to SQS queue with `triggerType: "schedule"`
- Lightweight resource requirements (256Mi RAM)

### Block Dispatcher

**Location:** `block-dispatcher/`

Monitors blockchain blocks via WebSocket and enqueues block-triggered workflows.

- Fetches active block-trigger workflows from KeeperHub API every 30s (configurable via `RECONCILE_INTERVAL_MS`)
- Opens WebSocket connections per chain using ethers.js `WebSocketProvider`
- Supports primary + fallback WSS endpoints per chain
- Filters blocks by each workflow's `blockInterval` (e.g., every 100th block)
- Sends matching workflows to SQS queue with `triggerType: "block"` and block data (number, hash, timestamp)
- Auto-reconnect with exponential backoff (1s to 30s, max 10 attempts)
- Dynamically creates/removes chain monitors based on active workflows

### Workflow Executor

**Location:** `/`

Polls SQS for workflow triggers and executes them.

- Continuously polls SQS queue using long-polling (20s wait)
- Routes messages by `triggerType`: schedule or block
- For **schedule triggers**: validates workflow + schedule enabled, creates execution record, triggers workflow, updates schedule status
- For **block triggers**: validates workflow enabled, creates execution record with block data, triggers workflow
- Processes up to 10 messages concurrently
- Uses 5-minute message visibility timeout
- Higher resource requirements (512Mi RAM)

### Why Separate Services?

1. **Fault isolation** - If executor crashes, dispatchers continue queuing work. SQS acts as a buffer.
2. **Independent scaling** - Executor can scale up during high load without affecting trigger evaluation.
3. **Decoupling** - SQS provides a buffer between trigger evaluation and resource-intensive execution.
4. **Resource efficiency** - Schedule dispatcher runs briefly once per minute. Block dispatcher maintains persistent WebSocket connections. Executor runs continuous SQS polling.

## Environment Variables

| Variable | Description | Used By |
|----------|-------------|---------|
| `KEEPERHUB_API_URL` | KeeperHub API base URL | All |
| `INTERNAL_SERVICE_HMAC_SECRET` | Shared HMAC secret for signing internal requests | All |
| `AWS_REGION` | AWS region | All |
| `SQS_QUEUE_URL` | SQS queue URL for workflow triggers | All |
| `HEALTH_PORT` | HTTP health check port (defaults: 3060 schedule-dispatcher, 3050 block-dispatcher) | All |
| `RECONCILE_INTERVAL_MS` | How often to refetch block workflows (default: 30000) | Block Dispatcher |
| `AWS_ENDPOINT_URL` | LocalStack endpoint (local dev only) | All |

## Development

### Prerequisites

- Node.js 25+
- pnpm

### Setup

```bash
pnpm install
pnpm typecheck
```

### Running Locally

Each service can be run independently:

```bash
# Schedule dispatcher - evaluates cron schedules every 60s
pnpm dispatcher

# Workflow executor - polls SQS and executes workflows
pnpm executor

# Block dispatcher - monitors blockchain blocks via WebSocket
pnpm block-dispatcher
```

For local development, the services default to:
- **KeeperHub API:** `http://localhost:3000`
- **SQS Queue:** LocalStack at `http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/keeperhub-workflow-queue`

To connect to real services, set the environment variables:

```bash
export KEEPERHUB_API_URL=http://your-api-url
export INTERNAL_SERVICE_HMAC_SECRET=your-internal-service-hmac-secret
export AWS_REGION=us-east-1
export SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/your-queue
```

## Docker

The project uses a multi-stage Dockerfile. Each service is a separate build target:

```bash
# Build each service independently
docker build --target dispatcher -t keeperhub-scheduler:dispatcher .
docker build --target executor -t keeperhub-scheduler:executor .
docker build --target block-dispatcher -t keeperhub-scheduler:block-dispatcher .
```

Run a container with required environment variables:

```bash
docker run -e KEEPERHUB_API_URL=http://host.docker.internal:3000 \
           -e INTERNAL_SERVICE_HMAC_SECRET=your-internal-service-hmac-secret \
           -e AWS_REGION=us-east-1 \
           -e SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/your-queue \
           -p 3000:3000 \
           keeperhub-scheduler:dispatcher
```

## Deployment

Deployed to EKS as three separate Helm releases using the `techops-services/common` chart:

- `keeperhub-scheduler-dispatcher` - Schedule evaluation service
- `keeperhub-scheduler-executor` - Workflow execution service
- `keeperhub-block-dispatcher` - Block monitoring service

### CI/CD

GitHub Actions automatically builds and deploys on push to `staging` or `prod` branches. The pipeline:

1. Detects which services changed (path-based filtering)
2. Builds only affected Docker images and pushes to AWS ECR
3. Deploys to EKS using Helm

### Deployment Order

When deploying the block-dispatcher feature for the first time, deploy the **executor first** (it handles both message types), then the **block-dispatcher** (which starts sending block messages to the shared SQS queue).

### Helm Values

See `deploy/staging/` and `deploy/prod/` for per-environment Helm configurations.
