export type ExecutionMode = "isolated" | "process" | "complex" | "in-process";

export type SqsHmacMode = "off" | "warn" | "enforce";

// Anything other than an explicit "off"/"enforce" falls back to "warn" so a
// typo can never silently disable verification (fail-safe default).
function parseSqsHmacMode(value: string | undefined): SqsHmacMode {
  return value === "off" || value === "enforce" ? value : "warn";
}

// Parse a non-negative integer env var, falling back on unset/blank/non-numeric.
// Unlike `Number(x) || fallback`, this honours an explicit 0 rather than
// treating it as falsy.
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const CONFIG = {
  executionMode: (process.env.EXECUTION_MODE || "isolated") as ExecutionMode,

  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/workflow",

  awsRegion: process.env.AWS_REGION || "us-east-1",
  awsEndpoint: process.env.AWS_ENDPOINT_URL,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  sqsQueueUrl:
    process.env.SQS_QUEUE_URL ||
    "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/keeperhub-workflow-queue",
  // Dead-letter queue for messages rejected without ever being processed
  // (malformed JSON, or a forged/invalid message dropped in enforce mode). When
  // set, those are copied here before being deleted from the main queue so they
  // are retained for audit instead of vanishing behind a log line. Unset (the
  // default) preserves the previous delete-only behaviour, so the executor can
  // ship ahead of the queue being provisioned.
  sqsDlqUrl: process.env.SQS_DLQ_URL,

  runnerImage: process.env.RUNNER_IMAGE || "keeperhub-runner:latest",
  imagePullPolicy: process.env.IMAGE_PULL_POLICY || "Never",
  namespace: process.env.K8S_NAMESPACE || "local",
  // Dedicated, zero-RBAC ServiceAccount for runner Job pods. The runner makes
  // no in-cluster Kubernetes API calls, so this SA has no Role/RoleBinding and
  // its token is never mounted (see automountServiceAccountToken below). Falls
  // back to "default" only for local clusters where the SA is not provisioned.
  runnerServiceAccount:
    process.env.RUNNER_SERVICE_ACCOUNT || "keeperhub-workflow-runner",
  // Name prefix of the External Secrets-synced K8s Secrets that the runner
  // Job pulls high-value credentials from via secretKeyRef (so they are never
  // written as literal values into the Job manifest). The chart materializes
  // one Secret per credential as `<prefix>-<slug>` with a single key of the
  // same name; this prefix is the executor Helm release fullname.
  runnerSecretPrefix:
    process.env.RUNNER_SECRET_PREFIX || "keeperhub-executor-common",
  // Ephemeral-storage guardrail for runner pods, matched by the /tmp emptyDir
  // sizeLimit (the runner's only writable path under readOnlyRootFilesystem).
  // The limit makes kubelet evict a single pod that writes pathologically much
  // to /tmp before it can threaten the node root volume; the request is a small
  // honest floor for scheduler/kubelet accounting. Sized from measurement:
  // sampling live staging runners showed ~2 MiB of ephemeral use each, so the
  // node disk pressure is driven by accumulated container images, not these
  // pods - the 1Gi limit is a ~500x runaway guard that never touches a normal
  // run. Env-overridable, read once at start (retune = env update + restart).
  runnerEphemeralStorageRequest:
    process.env.RUNNER_EPHEMERAL_STORAGE_REQUEST || "64Mi",
  runnerEphemeralStorageLimit:
    process.env.RUNNER_EPHEMERAL_STORAGE_LIMIT || "1Gi",
  // Finished runner pods hold their /tmp emptyDir + logs on the node until the
  // TTL controller deletes them. Kept short so a busy node reclaims that disk in
  // minutes rather than accumulating an hour of churn (the DiskPressure flap on
  // 2026-07-07). activeDeadlineSeconds caps a live run at 300s, so 300s here means
  // a pod is gone ~5 min after it finishes.
  jobTtlSeconds: Number(process.env.JOB_TTL_SECONDS) || 300,
  jobActiveDeadline: Number(process.env.JOB_ACTIVE_DEADLINE) || 300,
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS) || 1,

  keeperhubApiUrl: process.env.KEEPERHUB_API_URL || "http://localhost:3000",

  healthPort: Number(process.env.HEALTH_PORT) || 3080,
  integrationEncryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || "",

  chainRpcConfig: process.env.CHAIN_RPC_CONFIG || "",
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || "",

  workflowRunnerCollectMonitoring:
    process.env.WORKFLOW_RUNNER_COLLECT_MONITORING !== "false",

  // SQS trigger-message HMAC verification mode. "warn" (default)
  // verifies + records metrics but never drops a message, so shipping the
  // executor change alone cannot reject live traffic; flip to "enforce" once
  // rollout metrics show every producer is signing. Read once at process start,
  // so changing it takes an env update + pod restart (no code deploy needed).
  // "off" skips the checks entirely.
  sqsHmacMode: parseSqsHmacMode(process.env.SQS_HMAC_MODE),
  // Advisory freshness threshold (seconds) for a validly-signed message. Beyond
  // it a metric + warn is emitted, but the message is still processed - a queue
  // backlog can legitimately hold old messages, so age alone never drops a
  // trigger.
  sqsHmacMaxAgeSeconds: parseNonNegativeInt(
    process.env.SQS_HMAC_MAX_AGE_SECONDS,
    900
  ),
  // When true, a validly-signed message older than sqsHmacMaxAgeSeconds is
  // rejected in enforce mode, bounding replay to the freshness window. Default
  // false keeps freshness advisory so a queue backlog never drops real triggers;
  // enable once backlog behaviour is understood.
  sqsHmacMaxAgeEnforce: process.env.SQS_HMAC_MAX_AGE_ENFORCE === "true",

  visibilityTimeout: 300,
  waitTimeSeconds: 20,
  maxMessages: 10,
};
