import {
  BatchV1Api,
  KubeConfig,
  type V1EnvVar,
  type V1Job,
} from "@kubernetes/client-node";
import { CONFIG } from "./config";
import { getRunnerSystemEnvVars } from "./runner-env";

const kc = new KubeConfig();
kc.loadFromDefault();
const batchApi = kc.makeApiClient(BatchV1Api);

// Non-root identity for runner pods. Pinned to 1000/1000, the "node" user/group
// that ships in the node:alpine runner image (see the workflow-runner stage in
// Dockerfile), so the app files (world-readable) stay accessible while the
// container never runs as root. Coupled to that image: if the runner base image
// changes, confirm UID 1000 is a valid non-root user there and the app files are
// readable by it, otherwise update RUNNER_UID/RUNNER_GID to match.
const RUNNER_UID = 1000;
const RUNNER_GID = 1000;

// High-value credentials reach the runner via Kubernetes Secret references
// instead of literal env values, so plaintext never lands in the Job manifest
// (or etcd, or `kubectl get job -o yaml`). Each entry maps a runner env var to
// the credential slug used by the executor's External Secrets-synced Secrets;
// secret name == key == `${CONFIG.runnerSecretPrefix}-${slug}`. The slug is the
// SSM parameter short-name from deploy/executor/<env>/values.yaml and is NOT
// derivable from the env var (e.g. DATABASE_URL -> db-url), so it is listed
// explicitly. Verified against techops-staging and techops-prod (2026-06-02).
const SECRET_ENV_SLUGS: Record<string, string> = {
  DATABASE_URL: "db-url",
  INTEGRATION_ENCRYPTION_KEY: "integration-encryption-key",
  CHAIN_RPC_CONFIG: "chain-rpc-config",
  ETHERSCAN_API_KEY: "etherscan-api-key",
  METRICS_INGEST_TOKEN: "metrics-ingest-token",
  OPENAI_API_KEY: "openai-api-key",
  SENDGRID_API_KEY: "sendgrid-api-key",
  SIMPLE_ACCOUNT_7702_ADDRESS: "simple-account-7702-address",
  TURNKEY_API_PRIVATE_KEY: "turnkey-api-private-key",
  TURNKEY_API_PUBLIC_KEY: "turnkey-api-public-key",
};

// Only these are mandatory for any workflow to run (asserted by
// workflow-runner.ts at startup). The rest are plugin-specific, so their
// Secret refs are marked optional: a runner whose workflow does not need a
// given credential still starts if that Secret is absent.
const REQUIRED_SECRET_ENV = new Set([
  "DATABASE_URL",
  "INTEGRATION_ENCRYPTION_KEY",
]);

function secretEnvRef(name: string): V1EnvVar {
  const secretName = `${CONFIG.runnerSecretPrefix}-${SECRET_ENV_SLUGS[name]}`;
  return {
    name,
    valueFrom: {
      secretKeyRef: {
        name: secretName,
        key: secretName,
        optional: !REQUIRED_SECRET_ENV.has(name),
      },
    },
  };
}

// Semaphore to limit concurrent K8s Jobs
let activeJobs = 0;
const jobQueue: Array<{ resolve: () => void }> = [];

function acquireJobSlot(): Promise<void> {
  if (activeJobs < CONFIG.maxConcurrentJobs) {
    activeJobs++;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    jobQueue.push({ resolve });
  });
}

function releaseJobSlot(): void {
  activeJobs--;
  const next = jobQueue.shift();
  if (next) {
    activeJobs++;
    next.resolve();
  }
}

/**
 * Create a K8s Job to execute a workflow in an isolated container.
 * Respects MAX_CONCURRENT_JOBS limit to prevent cluster overload.
 * The Job runs keeperhub-executor/workflow-runner.ts via the runner image.
 */
export async function createWorkflowJob(params: {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType: string;
  scheduleId?: string;
}): Promise<V1Job> {
  const { workflowId, executionId, input, triggerType, scheduleId } = params;
  // Prefix with "keeperhub-" so the runner pod is captured by the Loki
  // security alert rules, which match pod=~".*keeperhub.*" (KEEP-612).
  // executeWorkflow -- and its content-scanner emit -- runs inside this pod
  // for web3-write (k8s-job-dispatched) workflows; without the prefix the
  // pod name "workflow-..." fell outside the matcher and those
  // security.content_scanner_hit signals never reached the alert.
  const jobName = `keeperhub-workflow-${executionId.substring(0, 8)}-${Date.now()}`;

  const envVars: V1EnvVar[] = [
    { name: "WORKFLOW_ID", value: workflowId },
    { name: "EXECUTION_ID", value: executionId },
    { name: "WORKFLOW_INPUT", value: JSON.stringify(input) },
    { name: "TRIGGER_TYPE", value: triggerType },
    // With readOnlyRootFilesystem the only writable path is the /tmp emptyDir
    // below. tsx/esbuild and any plugin temp writes resolve through TMPDIR, so
    // point it there to keep the runner working under the hardened context.
    { name: "TMPDIR", value: "/tmp" },
    // SSRF guard: runner pods enforce by default. safeFetch's shadow-mode
    // opt-in (SAFE_FETCH_SHADOW) is neither injected here nor listed in
    // RUNNER_SYSTEM_ENV_VARS, so a controller's env can never relax the
    // runner's SSRF enforcement -- the runner is the actual execution path.
    // High-value credentials as Secret references, never literal values.
    ...Object.keys(SECRET_ENV_SLUGS).map(secretEnvRef),
    ...(process.env.METRICS_COLLECTOR
      ? [{ name: "METRICS_COLLECTOR", value: process.env.METRICS_COLLECTOR }]
      : []),
    ...(process.env.EXECUTOR_METRICS_INGEST_URL
      ? [
          {
            name: "EXECUTOR_METRICS_INGEST_URL",
            value: process.env.EXECUTOR_METRICS_INGEST_URL,
          },
        ]
      : []),
  ];

  const explicitNames = new Set(envVars.map((v) => v.name));
  for (const systemVar of getRunnerSystemEnvVars()) {
    // Secret-valued system vars are injected via secretKeyRef above; never
    // relay them as plaintext through the controller's environment.
    if (SECRET_ENV_SLUGS[systemVar.name]) {
      continue;
    }
    if (!explicitNames.has(systemVar.name)) {
      envVars.push(systemVar);
    }
  }

  if (scheduleId) {
    envVars.push({ name: "SCHEDULE_ID", value: scheduleId });
  }

  const labels: Record<string, string> = {
    app: "workflow-runner",
    "workflow-id": workflowId,
    "execution-id": executionId,
    "trigger-type": triggerType,
  };

  if (scheduleId) {
    labels["schedule-id"] = scheduleId;
  }

  const job: V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: CONFIG.namespace,
      labels,
    },
    spec: {
      ttlSecondsAfterFinished: CONFIG.jobTtlSeconds,
      backoffLimit: 0,
      activeDeadlineSeconds: CONFIG.jobActiveDeadline,
      template: {
        metadata: {
          labels: {
            app: "workflow-runner",
            "workflow-id": workflowId,
            "execution-id": executionId,
          },
          ...(!CONFIG.workflowRunnerCollectMonitoring && {
            annotations: {
              "keeperhub.com/monitoring.exclude": "true",
            },
          }),
        },
        spec: {
          restartPolicy: "Never",
          // Dedicated zero-RBAC ServiceAccount and no projected token: the
          // runner makes no in-cluster Kubernetes API calls, so it should not
          // carry credentials that widen blast radius if a step is compromised.
          serviceAccountName: CONFIG.runnerServiceAccount,
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: RUNNER_UID,
            runAsGroup: RUNNER_GID,
            // Own the /tmp emptyDir as the runtime group so the non-root user
            // can write to it under readOnlyRootFilesystem.
            fsGroup: RUNNER_GID,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "runner",
              image: CONFIG.runnerImage,
              imagePullPolicy: CONFIG.imagePullPolicy,
              env: envVars,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
              resources: {
                requests: {
                  memory: "160Mi",
                  cpu: "200m",
                  "ephemeral-storage": CONFIG.runnerEphemeralStorageRequest,
                },
                limits: {
                  memory: "320Mi",
                  cpu: "750m",
                  "ephemeral-storage": CONFIG.runnerEphemeralStorageLimit,
                },
              },
            },
          ],
          // Sole writable path under readOnlyRootFilesystem; backs TMPDIR. The
          // sizeLimit caps this medium at the pod's ephemeral-storage limit so a
          // runaway runner is evicted on its own disk instead of filling the
          // node root volume and tripping node-wide DiskPressure.
          volumes: [
            {
              name: "tmp",
              emptyDir: { sizeLimit: CONFIG.runnerEphemeralStorageLimit },
            },
          ],
        },
      },
    },
  };

  await acquireJobSlot();

  try {
    const response = await batchApi.createNamespacedJob({
      namespace: CONFIG.namespace,
      body: job,
    });

    return response;
  } finally {
    releaseJobSlot();
  }
}
