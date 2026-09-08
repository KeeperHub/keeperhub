# E2E Tests for Schedule Trigger

These tests require the full infrastructure stack to be running.

## Prerequisites

### Option 1: Docker Compose (Local Development)

```bash
# Start all services
docker compose --profile dev up -d

# Create SQS queue in LocalStack
aws --endpoint-url=http://localhost:4566 sqs create-queue \
  --queue-name keeperhub-workflow-queue

# Run database migrations
pnpm db:push

# Start the Next.js app
pnpm dev

# In separate terminals, run the scheduler components:
# Terminal 1 - Dispatcher (run every minute or use watch)
watch -n 60 'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/workflow_builder" npx tsx scripts/scheduler/schedule-dispatcher.ts'

# Terminal 2 - Executor (long-running)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/workflow_builder" npx tsx scripts/scheduler/.ts
```

### Option 2: Minikube (K8s Local)

```bash
# Start minikube
minikube start

# Deploy LocalStack (requires LOCALSTACK_AUTH_TOKEN in environment)
envsubst < k8s/localstack.yaml | kubectl apply -f -

# Deploy the app
kubectl apply -f k8s/keeperhub.yaml

# Deploy the scheduler CronJob
kubectl apply -f k8s/schedule-dispatcher-cronjob.yaml

# Deploy the executor Deployment
kubectl apply -f k8s/-deployment.yaml
```

## Running E2E Tests

```bash
# Ensure infrastructure is running first
pnpm test:e2e:schedule
```

## Test Scenarios

### 1. Schedule Creation Flow

1. Create a workflow with Schedule trigger via UI
2. Verify schedule record exists in database
3. Verify nextRunAt is calculated correctly

### 2. Schedule Execution Flow

1. Create a workflow with Schedule trigger set to run in 1 minute
2. Wait for dispatcher to send message to SQS
3. Wait for executor to process message
4. Verify execution record created with status "running" then "completed"

### 3. Schedule Update Flow

1. Modify workflow schedule (change cron expression)
2. Verify schedule record updated
3. Verify nextRunAt recalculated

### 4. Schedule Deletion Flow

1. Change trigger type from Schedule to Manual/Webhook
2. Verify schedule record deleted

## Infrastructure Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        Test Runner                               │
│                    (Playwright + Vitest)                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      KeeperHub App                               │
│                   (Next.js on :3000)                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   UI        │  │  API Routes │  │  Schedule Service       │  │
│  │  (React)    │  │  /api/*     │  │  (sync on save)         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐  ┌─────────────┐  ┌─────────────────────────┐
│   PostgreSQL    │  │  LocalStack │  │  Scheduler Components   │
│   (DB on :5432) │  │  (SQS :4566)│  │                         │
│                 │  │             │  │  ┌───────────────────┐  │
│  - workflows    │  │  - queue    │  │  │    Dispatcher     │  │
│  - schedules    │  │             │  │  │  (CronJob/watch)  │  │
│  - executions   │  │             │  │  └───────────────────┘  │
│                 │  │             │  │           │             │
└─────────────────┘  └─────────────┘  │           ▼             │
                              ▲       │  ┌───────────────────┐  │
                              │       │  │     Executor      │  │
                              └───────┼──│  (Deployment/Job) │  │
                                      │  └───────────────────┘  │
                                      └─────────────────────────┘
```

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workflow_builder

# LocalStack/SQS
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_QUEUE_URL=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/keeperhub-workflow-queue

# App
KEEPERHUB_URL=http://localhost:3000
```
