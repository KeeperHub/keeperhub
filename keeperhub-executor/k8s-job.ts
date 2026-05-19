import { BatchV1Api, KubeConfig, type V1Job } from "@kubernetes/client-node";
import { CONFIG } from "./config";
import { getRunnerSystemEnvVars } from "./runner-env";

const kc = new KubeConfig();
kc.loadFromDefault();
const batchApi = kc.makeApiClient(BatchV1Api);

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
  const jobName = `workflow-${executionId.substring(0, 8)}-${Date.now()}`;

  const envVars = [
    { name: "WORKFLOW_ID", value: workflowId },
    { name: "EXECUTION_ID", value: executionId },
    { name: "WORKFLOW_INPUT", value: JSON.stringify(input) },
    { name: "DATABASE_URL", value: CONFIG.databaseUrl },
    {
      name: "INTEGRATION_ENCRYPTION_KEY",
      value: CONFIG.integrationEncryptionKey,
    },
    { name: "PARA_API_KEY", value: CONFIG.paraApiKey },
    { name: "PARA_ENVIRONMENT", value: CONFIG.paraEnvironment },
    { name: "WALLET_ENCRYPTION_KEY", value: CONFIG.walletEncryptionKey },
    { name: "CHAIN_RPC_CONFIG", value: CONFIG.chainRpcConfig },
    ...(CONFIG.etherscanApiKey
      ? [{ name: "ETHERSCAN_API_KEY", value: CONFIG.etherscanApiKey }]
      : []),
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
    ...(process.env.METRICS_INGEST_TOKEN
      ? [
          {
            name: "METRICS_INGEST_TOKEN",
            value: process.env.METRICS_INGEST_TOKEN,
          },
        ]
      : []),
  ];

  const explicitNames = new Set(envVars.map((v) => v.name));
  for (const systemVar of getRunnerSystemEnvVars()) {
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
          containers: [
            {
              name: "runner",
              image: CONFIG.runnerImage,
              imagePullPolicy: CONFIG.imagePullPolicy,
              env: envVars,
              resources: {
                requests: { memory: "160Mi", cpu: "200m" },
                limits: { memory: "320Mi", cpu: "750m" },
              },
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
