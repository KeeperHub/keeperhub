# Workflow Execution Runtime: K8s Job Architecture

This document outlines the plan to move workflow execution from the KeeperHub API into isolated Kubernetes Jobs.

## Decision Record

**Date**: 2024-12-12

**Decision**: Use SQS as a message buffer between the Dispatcher and Job Spawner (Option A)

**Alternatives Considered**:
- **Option A (chosen)**: Dispatcher → SQS → Job Spawner → K8s Job
- **Option B (rejected)**: Dispatcher → K8s Job directly (no SQS)

**Rationale for Option A**:
1. **Existing code**: We already have working SQS infrastructure (dispatcher, executor, LocalStack setup)
2. **Reference implementation**: `keeper-app/` uses SQS for similar workloads - provides patterns for deployment, development, and maintenance
3. **Resilience**: SQS buffers messages if K8s API is temporarily unavailable
4. **Dead letter queue**: Failed messages can be captured for debugging
5. **Rate limiting**: Can control job creation rate via SQS consumers
6. **Proven pattern**: Decoupled architecture is easier to debug and monitor

**Trade-offs accepted**:
- Additional infrastructure component (LocalStack locally, AWS SQS in production)
- Slightly more complex flow
- Small latency overhead from queue polling

**Reference Implementation**: See `keeper-app/` for SQS patterns used in production.

---

## Reference: keeper-app SQS Patterns

The `keeper-app/` project in this workspace uses SQS for similar workloads. Use it as a reference for:

| Area | What to Reference |
|------|-------------------|
| **Local Development** | LocalStack setup, docker-compose configuration |
| **SQS Client** | AWS SDK configuration, message handling patterns |
| **Error Handling** | Retry logic, dead letter queue setup |
| **Deployment** | K8s manifests, environment configuration |
| **Monitoring** | CloudWatch metrics, alerting patterns |

When implementing the Job Spawner, review `keeper-app/` for:
- How SQS consumers are structured
- Message visibility timeout handling
- Graceful shutdown patterns
- Health check implementations

---

## Current Architecture (Problem)

```
┌─────────────────┐     ┌─────────────────────────────────────────────┐
│    Executor     │────▶│            KeeperHub API Pod                │
│  (SQS consumer) │     │  ┌─────────────────────────────────────┐   │
└─────────────────┘     │  │  POST /api/workflow/{id}/execute    │   │
                        │  │                                     │   │
                        │  │  1. Validate auth/ownership         │   │
                        │  │  2. Create execution record         │   │
                        │  │  3. executeWorkflowBackground()     │◀──┼── Blocks API
                        │  │     └── executeWorkflow()           │      resources
                        │  │         └── executeNode() (loop)    │
                        │  │             └── fetch credentials   │
                        │  │             └── run step            │
                        │  │  4. Update execution record         │   │
                        │  └─────────────────────────────────────┘   │
                        └─────────────────────────────────────────────┘
```

### Problems

1. **Resource Contention**: Workflows compete with API requests for CPU/memory
2. **No Isolation**: A bad workflow can crash the API pod
3. **Timeout Limits**: API request timeouts limit workflow duration
4. **No Scaling**: Can't scale execution independently from API
5. **Observability**: Hard to track individual workflow resource usage

---

## Proposed Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────────────┐
│   Dispatcher    │────▶│   SQS Queue     │────▶│    Job Spawner           │
│   (CronJob)     │     │  (LocalStack/   │     │    (Deployment)          │
│                 │     │   AWS SQS)      │     │                          │
│ Runs every min  │     │                 │     │  Polls SQS, creates      │
│ Checks schedules│     │  Message buffer │     │  K8s Job per message     │
└─────────────────┘     └─────────────────┘     └──────────────────────────┘
        │                       │                          │
        │                       │                          │ kubectl create job
        ▼                       ▼                          ▼
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────────────┐
│   PostgreSQL    │     │  Dead Letter    │     │   Workflow Runner Job    │
│                 │     │  Queue (DLQ)    │     │   (isolated container)   │
│ workflow_       │     │                 │     │                          │
│ schedules table │     │ Failed messages │     │   - Receives workflow ID │
└─────────────────┘     └─────────────────┘     │   - Fetches workflow def │
                                                │   - Executes steps       │
                                                │   - Updates DB status    │
                                                │   - Self-terminates      │
                                                └──────────────────────────┘
                                                           │
                                                           ▼
                                                ┌──────────────────────────┐
                                                │   PostgreSQL             │
                                                │   workflow_executions    │
                                                │   (status updates)       │
                                                └──────────────────────────┘
```

### Component Responsibilities

| Component | Type | Responsibility |
|-----------|------|----------------|
| **Dispatcher** | CronJob | Query due schedules, send messages to SQS |
| **SQS Queue** | Infrastructure | Buffer messages, provide retry/DLQ |
| **Job Spawner** | Deployment | Poll SQS, create K8s Jobs |
| **Workflow Runner** | K8s Job | Execute workflow in isolation |

### Why SQS Between Dispatcher and Job Spawner?

```
Without SQS:  Dispatcher ──────────────────────▶ K8s API (create job)
                           │
                           └── If K8s API is slow/down, dispatcher blocks

With SQS:     Dispatcher ──▶ SQS ──▶ Job Spawner ──▶ K8s API
                           │         │
                           │         └── Can retry, has backoff
                           └── Fire and forget, dispatcher continues
```

SQS provides:
- **Decoupling**: Dispatcher doesn't wait for job creation
- **Buffering**: Messages queue up if job creation is slow
- **Retry**: Failed job creations can be retried
- **Visibility**: Queue depth shows backlog
- **DLQ**: Persistent failures captured for debugging

---

## Components

### 1. Job Spawner (replaces current executor)

**Location**: `keeperhub-executor/index.ts`

**Responsibilities**:
- Poll SQS for workflow trigger messages
- Create K8s Job for each workflow execution
- Pass execution context via environment variables or ConfigMap
- Monitor job completion (optional)
- Clean up completed jobs

**Flow**:
```typescript
// Pseudo-code
while (true) {
  const message = await sqs.receiveMessage();
  if (message) {
    const { workflowId, executionId, input } = JSON.parse(message.body);

    // Create K8s Job
    await k8s.createJob({
      name: `workflow-${executionId}`,
      image: 'keeperhub-runner:latest',
      env: {
        WORKFLOW_ID: workflowId,
        EXECUTION_ID: executionId,
        WORKFLOW_INPUT: JSON.stringify(input),
      },
    });

    await sqs.deleteMessage(message);
  }
}
```

### 2. Workflow Runner (new image)

**Location**: `keeperhub-executor/workflow-runner.ts`

**Responsibilities**:
- Receive execution context from environment
- Fetch workflow definition from database
- Execute workflow steps
- Update execution status in database
- Exit with appropriate code (0 = success, 1 = failure)

**Flow**:
```typescript
// keeperhub-executor/workflow-runner.ts
async function main() {
  const workflowId = process.env.WORKFLOW_ID;
  const executionId = process.env.EXECUTION_ID;
  const input = JSON.parse(process.env.WORKFLOW_INPUT || '{}');

  try {
    // Update status to running
    await updateExecutionStatus(executionId, 'running');

    // Fetch workflow from DB
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId)
    });

    // Execute workflow
    const result = await executeWorkflow({
      nodes: workflow.nodes,
      edges: workflow.edges,
      triggerInput: input,
      executionId,
      workflowId,
    });

    // Update status
    await updateExecutionStatus(executionId, result.success ? 'success' : 'error');

    process.exit(result.success ? 0 : 1);
  } catch (error) {
    await updateExecutionStatus(executionId, 'error', error.message);
    process.exit(1);
  }
}
```

### 3. Workflow Runner Docker Image

**Dockerfile stage**: `runner` (new)

```dockerfile
FROM node:25-alpine AS workflow-runner
WORKDIR /app
RUN npm install -g pnpm tsx

# Copy dependencies and execution code
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/plugins ./plugins
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production

# Default command - can be overridden
CMD ["tsx", "keeperhub-executor/workflow-runner.ts"]
```

---

## Execution Flow (New)

### Scheduled Workflow Execution

```
1. Dispatcher CronJob runs every minute
   └── Finds schedules due to run
   └── Sends message to SQS: { workflowId, scheduleId, triggerTime }

2. Job Spawner polls SQS
   └── Receives message
   └── Creates execution record in DB (status: pending)
   └── Creates K8s Job with env vars

3. K8s Job starts
   └── workflow-runner.ts starts
   └── Updates execution status: running
   └── Fetches workflow definition
   └── Executes each step
   └── Updates execution status: success/error
   └── Container exits

4. K8s cleans up Job (TTL or manual)
```

### Manual/API Workflow Execution

```
1. User calls POST /api/workflow/{id}/execute
   └── API validates auth
   └── Creates execution record (status: pending)
   └── Sends message to SQS (or creates Job directly)
   └── Returns executionId immediately

2. Job Spawner (or API) creates K8s Job
   └── Same flow as scheduled execution
```

---

## K8s Job Specification

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: workflow-exec-${executionId}
  namespace: local
  labels:
    app: workflow-runner
    workflow-id: ${workflowId}
    execution-id: ${executionId}
spec:
  ttlSecondsAfterFinished: 300    # Delete finished pods fast to release node disk (env JOB_TTL_SECONDS)
  backoffLimit: 0                 # No retries (handle in app)
  activeDeadlineSeconds: 300      # 5 minute timeout
  template:
    metadata:
      labels:
        app: workflow-runner
    spec:
      restartPolicy: Never
      containers:
        - name: runner
          image: keeperhub-runner:latest
          imagePullPolicy: Never  # Local dev
          env:
            - name: WORKFLOW_ID
              value: "${workflowId}"
            - name: EXECUTION_ID
              value: "${executionId}"
            - name: WORKFLOW_INPUT
              value: "${inputJson}"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: keeperhub-secrets
                  key: database-url
            - name: INTEGRATION_ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: keeperhub-secrets
                  key: integration-encryption-key
          volumeMounts:
            - name: tmp
              mountPath: /tmp        # sole writable path (readOnlyRootFilesystem)
          resources:
            requests:
              memory: "160Mi"
              cpu: "200m"
              ephemeral-storage: "64Mi"  # honest floor for accounting (env RUNNER_EPHEMERAL_STORAGE_REQUEST)
            limits:
              memory: "320Mi"
              cpu: "750m"
              ephemeral-storage: "1Gi"   # runaway-/tmp guard (~2 MiB normal); evicts a pathological pod before it threatens the node (env RUNNER_EPHEMERAL_STORAGE_LIMIT)
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: "1Gi"       # caps the runner's write medium at the pod's ephemeral-storage limit
```

---

## Security Considerations

### Credential Access

Workflows need access to:
1. **Database credentials** - to fetch workflow definition and update status
2. **Integration encryption key** - to decrypt user's integration credentials
3. **User's integration credentials** - fetched and decrypted at runtime

**Solution**:
- Pass `DATABASE_URL` and `INTEGRATION_ENCRYPTION_KEY` via K8s Secrets
- Integration credentials are fetched from DB using `integrationId` in workflow config
- Decryption happens inside the runner container

### Network Isolation

- Runner pods should only access:
  - PostgreSQL (for workflow/execution data)
  - External APIs (for step execution - Slack, Resend, etc.)
- Consider NetworkPolicy to restrict access

### Resource Limits

- Set `resources.limits` to prevent runaway workflows
- Set an `ephemeral-storage` limit and a matching `/tmp` emptyDir `sizeLimit` so a pod that writes pathologically much to `/tmp` (normal runners use ~2 MiB) is evicted on its own disk before it can fill the shared node root volume. Node-level disk pressure from accumulated container images is handled separately (kubelet image GC + node disk sizing), not here
- Set `activeDeadlineSeconds` for timeout
- Set `ttlSecondsAfterFinished` low so finished pods release their `/tmp` disk within minutes

---

## Implementation Phases

### Phase 1: Workflow Runner Script
- [ ] Create `keeperhub-executor/workflow-runner.ts`
- [ ] Extract execution logic from API route
- [ ] Add environment variable handling
- [ ] Add proper exit codes and error handling
- [ ] Test locally with `tsx keeperhub-executor/workflow-runner.ts`

### Phase 2: Docker Image
- [ ] Add `workflow-runner` stage to Dockerfile
- [ ] Include all necessary files (lib/, plugins/, etc.)
- [ ] Test image builds successfully
- [ ] Verify execution works in container

### Phase 3: Job Spawner
- [ ] Create `keeperhub-executor/index.ts`
- [ ] Implement K8s Job creation via API
- [ ] Handle SQS message processing
- [ ] Add job cleanup logic
- [ ] Update `schedule-trigger.yaml` to use job-spawner

### Phase 4: API Integration
- [ ] Update `/api/workflow/{id}/execute` to queue jobs
- [ ] Add execution status polling endpoint (if needed)
- [ ] Remove in-process execution code
- [ ] Update tests

### Phase 5: Production Readiness
- [ ] Add K8s Secrets for credentials
- [ ] Configure NetworkPolicy
- [ ] Add monitoring/alerting for job failures
- [ ] Document operational procedures
- [ ] Load testing

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `keeperhub-executor/workflow-runner.ts` | Create | Standalone workflow execution script |
| `keeperhub-executor/index.ts` | Create | SQS consumer that creates K8s Jobs |
| `Dockerfile` | Modify | Add `workflow-runner` build stage |
| `deploy/local/schedule-trigger.yaml` | Modify | Update executor to job-spawner |
| `deploy/local/workflow-runner-job.yaml` | Create | Job template for reference |
| `app/api/workflow/[workflowId]/execute/route.ts` | Modify | Queue job instead of inline execution |
| `lib/k8s-client.ts` | Create | K8s API client for job creation |

---

## Code to Extract

The following code from `lib/workflow-executor.workflow.ts` needs to work in the runner:

1. `executeWorkflow()` - Main execution function
2. `executeNode()` - Node execution logic
3. `executeActionStep()` - Action step execution
4. `processTemplates()` - Template variable replacement
5. `evaluateConditionExpression()` - Condition evaluation

Dependencies:
- `lib/step-registry.ts` - Action type mapping
- `lib/steps/*` - Step implementations
- `plugins/*/steps/*` - Plugin step implementations
- `lib/db/integrations.ts` - Credential fetching/decryption
- `lib/workflow/nodes/condition/validator.ts` - Condition security validation

---

## Open Questions

1. **Job cleanup strategy**: TTL vs manual cleanup vs separate cleanup job?
2. **Logging**: How to aggregate logs from short-lived Job pods?
3. **Secrets management**: K8s Secrets vs external secrets manager?
4. **Retries**: Handle at Job level (backoffLimit) or application level?
5. **Concurrency**: Limit concurrent executions per user/workflow?

---

## Alternatives Considered

### Execution Runtime Options

| Approach | Pros | Cons |
|----------|------|------|
| **K8s Jobs + SQS** (chosen) | Per-execution isolation, resilient queue, proven pattern | Job creation overhead, pod startup time, more components |
| **K8s Jobs (no SQS)** | Simpler, fewer components | Dispatcher blocks on K8s API, less resilient |
| **Worker Deployment** | Faster (no pod startup), simpler | Shared resources, less isolation |
| **AWS Lambda** | Serverless, auto-scaling | Cold starts, vendor lock-in, 15min limit |
| **Temporal** | Robust orchestration, retries | Complex, additional infrastructure |

### Message Queue Options

| Approach | Pros | Cons |
|----------|------|------|
| **SQS** (chosen) | Managed, reliable, DLQ support, keeper-app reference | AWS dependency, LocalStack for local dev |
| **Redis Queue** | Fast, simple, already have Redis? | Less durable, manual DLQ |
| **RabbitMQ** | Feature-rich, routing | Another service to manage |
| **No Queue** | Simplest | No buffering, no retry, dispatcher blocks |
