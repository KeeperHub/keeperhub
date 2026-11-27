import type { V1EnvVar, V1Job } from "@kubernetes/client-node";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

let mockCreateNamespacedJob: Mock;
let mockListNamespacedPod: Mock;

vi.mock("@kubernetes/client-node", () => {
  mockListNamespacedPod = vi.fn();
  mockCreateNamespacedJob = vi.fn().mockResolvedValue({
    metadata: { name: "workflow-test-123" },
  } as V1Job);

  class MockKubeConfig {
    loadFromDefault(): void {
      // no-op for test mock
    }
    makeApiClient(): {
      createNamespacedJob: Mock;
      listNamespacedPod: Mock;
    } {
      return {
        createNamespacedJob: mockCreateNamespacedJob,
        listNamespacedPod: mockListNamespacedPod,
      };
    }
  }

  return {
    KubeConfig: MockKubeConfig,
    BatchV1Api: class {},
    CoreV1Api: class {},
  };
});

vi.mock("./config", () => ({
  CONFIG: {
    databaseUrl: "postgres://localhost/test",
    integrationEncryptionKey: "test-enc-key",
    chainRpcConfig: '{"eth":"http://localhost:8545"}',
    etherscanApiKey: "test-etherscan-key",
    namespace: "test-ns",
    runnerServiceAccount: "keeperhub-workflow-runner",
    runnerSecretPrefix: "keeperhub-executor-common",
    runnerImage: "runner:latest",
    imagePullPolicy: "Never",
    runnerEphemeralStorageRequest: "64Mi",
    runnerEphemeralStorageLimit: "1Gi",
    jobTtlSeconds: 300,
    jobActiveDeadline: 600,
    jobDrainTimeoutMs: 400_000,
    maxConcurrentJobs: 5,
  },
}));

vi.mock("./runner-env", () => ({
  getRunnerSystemEnvVars: vi.fn().mockReturnValue([
    { name: "OPENAI_API_KEY", value: "sk-test" },
    { name: "SLACK_API_KEY", value: "xoxb-test" },
  ]),
}));

const {
  createWarmRunnerJob,
  createWorkflowJob,
  getRunnerPodIps,
  WARM_POOL_LABEL,
} = await import("./k8s-job");
const { CONFIG } = await import("./config");
const { getRunnerSystemEnvVars } = await import("./runner-env");

function getSubmittedJob(): V1Job {
  const call = mockCreateNamespacedJob.mock.calls[0][0];
  return call.body as V1Job;
}

function getJobEnvVars(job: V1Job): V1EnvVar[] {
  return job.spec?.template?.spec?.containers?.[0]?.env ?? [];
}

function getEnvVar(envVars: V1EnvVar[], name: string): string | undefined {
  return envVars.find((v) => v.name === name)?.value;
}

function getHeapCapMib(envVars: V1EnvVar[]): number {
  const nodeOptions = getEnvVar(envVars, "NODE_OPTIONS") ?? "";
  const match = nodeOptions.match(/--max-old-space-size=(\d+)/);
  if (!match) {
    throw new Error(`No heap cap in NODE_OPTIONS: "${nodeOptions}"`);
  }
  return Number(match[1]);
}

function getMemoryLimitMib(job: V1Job): number {
  const limit =
    job.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory;
  if (typeof limit !== "string") {
    throw new Error("Runner container declares no memory limit");
  }
  const match = limit.match(/^(\d+)(Mi|Gi)$/);
  if (!match) {
    throw new Error(`Unsupported memory limit format: "${limit}"`);
  }
  return match[2] === "Gi" ? Number(match[1]) * 1024 : Number(match[1]);
}

function getSecretRef(
  envVars: V1EnvVar[],
  name: string
): { name?: string; key?: string; optional?: boolean } | undefined {
  return envVars.find((v) => v.name === name)?.valueFrom?.secretKeyRef;
}

describe("createWorkflowJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CONFIG as Record<string, unknown>).etherscanApiKey = "test-etherscan-key";
    delete (CONFIG as Record<string, unknown>).workflowRunnerCollectMonitoring;
    delete process.env.METRICS_COLLECTOR;
    delete process.env.EXECUTOR_METRICS_INGEST_URL;
    delete process.env.METRICS_INGEST_TOKEN;
    delete process.env.SAFE_FETCH_SHADOW;
  });

  it("forwards non-secret metrics env vars as literals when set", async () => {
    process.env.METRICS_COLLECTOR = "prometheus";
    process.env.EXECUTOR_METRICS_INGEST_URL = "http://executor:3080";

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "METRICS_COLLECTOR")).toBe("prometheus");
    expect(getEnvVar(envVars, "EXECUTOR_METRICS_INGEST_URL")).toBe(
      "http://executor:3080"
    );
  });

  it("omits non-secret metrics literals when unset", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(envVars.find((v) => v.name === "METRICS_COLLECTOR")).toBeUndefined();
    expect(
      envVars.find((v) => v.name === "EXECUTOR_METRICS_INGEST_URL")
    ).toBeUndefined();
  });

  it("injects METRICS_INGEST_TOKEN as an optional secret ref, not a literal", async () => {
    process.env.METRICS_INGEST_TOKEN = "should-not-be-relayed";

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "METRICS_INGEST_TOKEN")).toBeUndefined();
    expect(getSecretRef(envVars, "METRICS_INGEST_TOKEN")).toEqual({
      name: "keeperhub-executor-common-metrics-ingest-token",
      key: "keeperhub-executor-common-metrics-ingest-token",
      optional: true,
    });
  });

  it("references ETHERSCAN_API_KEY as an optional secret ref", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "ETHERSCAN_API_KEY")).toBeUndefined();
    expect(getSecretRef(envVars, "ETHERSCAN_API_KEY")).toEqual({
      name: "keeperhub-executor-common-etherscan-api-key",
      key: "keeperhub-executor-common-etherscan-api-key",
      optional: true,
    });
  });

  it("forwards non-secret system env vars from runner-env as literals", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "SLACK_API_KEY")).toBe("xoxb-test");
  });

  it("never relays secret-valued system vars as plaintext", async () => {
    (getRunnerSystemEnvVars as Mock).mockReturnValue([
      { name: "DATABASE_URL", value: "should-be-ignored" },
      { name: "OPENAI_API_KEY", value: "should-be-ignored" },
    ]);

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    const dbUrls = envVars.filter((v) => v.name === "DATABASE_URL");
    expect(dbUrls).toHaveLength(1);
    expect(dbUrls[0].value).toBeUndefined();
    expect(dbUrls[0].valueFrom?.secretKeyRef?.name).toBe(
      "keeperhub-executor-common-db-url"
    );
    const openai = envVars.filter((v) => v.name === "OPENAI_API_KEY");
    expect(openai).toHaveLength(1);
    expect(openai[0].value).toBeUndefined();
  });

  it("references Turnkey API keys as optional secret refs", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getSecretRef(envVars, "TURNKEY_API_PUBLIC_KEY")).toEqual({
      name: "keeperhub-executor-common-turnkey-api-public-key",
      key: "keeperhub-executor-common-turnkey-api-public-key",
      optional: true,
    });
    expect(getSecretRef(envVars, "TURNKEY_API_PRIVATE_KEY")).toEqual({
      name: "keeperhub-executor-common-turnkey-api-private-key",
      key: "keeperhub-executor-common-turnkey-api-private-key",
      optional: true,
    });
    expect(getEnvVar(envVars, "TURNKEY_API_PRIVATE_KEY")).toBeUndefined();
  });

  it("references the bundle searcher key as an optional secret ref, never plaintext", async () => {
    (getRunnerSystemEnvVars as Mock).mockReturnValue([
      { name: "BUNDLE_SEARCHER_PRIVATE_KEY", value: "should-be-ignored" },
    ]);
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    const refs = envVars.filter((v) => v.name === "BUNDLE_SEARCHER_PRIVATE_KEY");
    expect(refs).toHaveLength(1);
    expect(refs[0].value).toBeUndefined();
    expect(getSecretRef(envVars, "BUNDLE_SEARCHER_PRIVATE_KEY")).toEqual({
      name: "keeperhub-executor-common-bundle-searcher-private-key",
      key: "keeperhub-executor-common-bundle-searcher-private-key",
      optional: true,
    });
  });

  it("includes SCHEDULE_ID for scheduled triggers", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
      scheduleId: "sched-42",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "SCHEDULE_ID")).toBe("sched-42");
  });

  it("omits SCHEDULE_ID for non-scheduled triggers", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "block",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(envVars.find((v) => v.name === "SCHEDULE_ID")).toBeUndefined();
  });

  it("passes non-secret execution context as literal env vars", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: { test: true },
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());

    expect(getEnvVar(envVars, "WORKFLOW_ID")).toBe("wf-1");
    expect(getEnvVar(envVars, "EXECUTION_ID")).toBe("exec-1234abcd");
    expect(getEnvVar(envVars, "WORKFLOW_INPUT")).toBe('{"test":true}');
  });

  it("gives the runner its deadline, counted from now as the Job's starts no earlier", async () => {
    const before = Date.now();
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "manual",
    });
    const deadline = Number(
      getEnvVar(getJobEnvVars(getSubmittedJob()), "KH_RUN_DEADLINE_AT")
    );
    expect(deadline).toBeGreaterThanOrEqual(
      before + CONFIG.jobActiveDeadline * 1000
    );
    expect(deadline).toBeLessThanOrEqual(
      Date.now() + CONFIG.jobActiveDeadline * 1000
    );
  });

  it("references core credentials as required (non-optional) secret refs", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());

    // No plaintext for any of the high-value credentials.
    expect(getEnvVar(envVars, "DATABASE_URL")).toBeUndefined();
    expect(getEnvVar(envVars, "INTEGRATION_ENCRYPTION_KEY")).toBeUndefined();
    expect(getEnvVar(envVars, "CHAIN_RPC_CONFIG")).toBeUndefined();

    expect(getSecretRef(envVars, "DATABASE_URL")).toEqual({
      name: "keeperhub-executor-common-db-url",
      key: "keeperhub-executor-common-db-url",
      optional: false,
    });
    expect(getSecretRef(envVars, "INTEGRATION_ENCRYPTION_KEY")).toEqual({
      name: "keeperhub-executor-common-integration-encryption-key",
      key: "keeperhub-executor-common-integration-encryption-key",
      optional: false,
    });
    // CHAIN_RPC_CONFIG is plugin-specific, so it is optional.
    expect(getSecretRef(envVars, "CHAIN_RPC_CONFIG")?.optional).toBe(true);
  });

  it("injects no SSRF shadow opt-in on runner pods, so they enforce by default", async () => {
    // SSRF guard must be on regardless of controller config to prevent
    // workflow runs from reaching internal hosts (cloud IMDS, RFC1918,
    // in-cluster services). The runner pod is the actual execution path.
    // safeFetch is fail-closed by default, so the executor injects no
    // shadow opt-in; the absence of SAFE_FETCH_SHADOW means the runner
    // enforces.
    delete process.env.SAFE_FETCH_SHADOW;

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "SAFE_FETCH_SHADOW")).toBeUndefined();
  });

  it("does not forward the controller's SAFE_FETCH_SHADOW opt-in to runner pods", async () => {
    // A controller-level shadow opt-in (a dev/CI escape hatch) must never
    // propagate to the runner, which executes user workflow code. The
    // executor neither injects nor forwards SAFE_FETCH_SHADOW.
    process.env.SAFE_FETCH_SHADOW = "true";

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "SAFE_FETCH_SHADOW")).toBeUndefined();
  });

  it("runs under the dedicated SA with no mounted token", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const podSpec = getSubmittedJob().spec?.template?.spec;
    expect(podSpec?.serviceAccountName).toBe("keeperhub-workflow-runner");
    expect(podSpec?.automountServiceAccountToken).toBe(false);
  });

  it("applies a non-root pod securityContext", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const podSecurityContext =
      getSubmittedJob().spec?.template?.spec?.securityContext;
    expect(podSecurityContext?.runAsNonRoot).toBe(true);
    expect(podSecurityContext?.runAsUser).toBe(1000);
    expect(podSecurityContext?.runAsGroup).toBe(1000);
    expect(podSecurityContext?.fsGroup).toBe(1000);
    expect(podSecurityContext?.seccompProfile?.type).toBe("RuntimeDefault");
  });

  it("locks down the runner container securityContext", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const container = getSubmittedJob().spec?.template?.spec?.containers?.[0];
    expect(container?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(container?.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(container?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });

  it("mounts a writable /tmp emptyDir backing TMPDIR", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const job = getSubmittedJob();
    const podSpec = job.spec?.template?.spec;
    const tmpVolume = podSpec?.volumes?.find((v) => v.name === "tmp");
    expect(tmpVolume?.emptyDir).toBeDefined();

    const tmpMount = podSpec?.containers?.[0]?.volumeMounts?.find(
      (m) => m.name === "tmp"
    );
    expect(tmpMount?.mountPath).toBe("/tmp");

    const envVars = getJobEnvVars(job);
    expect(getEnvVar(envVars, "TMPDIR")).toBe("/tmp");
  });

  it("bounds runner disk with ephemeral-storage requests/limits and a matching /tmp sizeLimit", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const job = getSubmittedJob();
    const resources = job.spec?.template?.spec?.containers?.[0]?.resources;
    // Small honest floor for the request; the limit is a runaway-/tmp guard
    // (normal runners use ~2 MiB) that evicts a single pathological pod before
    // it can threaten the node root volume.
    expect(resources?.requests?.["ephemeral-storage"]).toBe("64Mi");
    expect(resources?.limits?.["ephemeral-storage"]).toBe("1Gi");

    // The only writable medium (/tmp emptyDir) is capped at the pod limit so a
    // runaway runner is evicted on its own disk, not the shared node volume.
    const tmpVolume = job.spec?.template?.spec?.volumes?.find(
      (v) => v.name === "tmp"
    );
    expect(tmpVolume?.emptyDir?.sizeLimit).toBe("1Gi");
  });

  it("keeps finished runner pods only briefly so node disk is reclaimed fast", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    expect(getSubmittedJob().spec?.ttlSecondsAfterFinished).toBe(300);
  });

  it("opts a runner pod out of voluntary node disruption", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const job = getSubmittedJob();
    const annotations = job.spec?.template?.metadata?.annotations;

    // backoffLimit 0 means an evicted pod fails the Job outright and loses the
    // execution, so the pod must not be drained out from under a live run.
    expect(job.spec?.backoffLimit).toBe(0);
    expect(annotations?.["karpenter.sh/do-not-disrupt"]).toBe("true");
    // The monitoring opt-out rides in the same annotation map; it is on by
    // default here because the mocked config leaves collection disabled.
    expect(annotations?.["keeperhub.com/monitoring.exclude"]).toBe("true");
  });

  it("keeps the disruption opt-out when monitoring collection is enabled", async () => {
    (CONFIG as Record<string, unknown>).workflowRunnerCollectMonitoring = true;

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const annotations = getSubmittedJob().spec?.template?.metadata?.annotations;

    expect(annotations?.["karpenter.sh/do-not-disrupt"]).toBe("true");
    expect(annotations?.["keeperhub.com/monitoring.exclude"]).toBeUndefined();
  });

  it("gives the drain watchdog a budget that expires before the pod is killed", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const job = getSubmittedJob();
    const drainMs = Number(
      getEnvVar(getJobEnvVars(job), "KH_EXECUTOR_DRAIN_TIMEOUT_MS")
    );
    const deadlineMs = (job.spec?.activeDeadlineSeconds ?? 0) * 1000;

    expect(drainMs).toBe(400_000);
    expect(drainMs).toBeLessThan(deadlineMs);
  });

  it("propagates a label-safe correlation id to the Job env and labels", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "event",
      correlationId: "abcd1234efgh5678",
      latencyEpochs: { receivedAt: 1_000, observedAt: 500 },
    });

    const job = getSubmittedJob();
    expect(job.metadata?.labels?.["correlation-id"]).toBe("abcd1234efgh5678");
    const envVars = getJobEnvVars(job);
    expect(getEnvVar(envVars, "KH_CORRELATION_ID")).toBe("abcd1234efgh5678");
    expect(getEnvVar(envVars, "KH_RECEIVED_AT")).toBe("1000");
    expect(getEnvVar(envVars, "KH_OBSERVED_AT")).toBe("500");
  });

  it("never puts a label-unsafe correlation id on the Job", async () => {
    // A Kubernetes label value caps at 63 characters with a restricted
    // charset; an invalid value fails Job creation, which would turn a bad
    // correlation id into a workflow that never runs.
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "event",
      correlationId: `bad/${"a".repeat(70)}`,
    });

    const job = getSubmittedJob();
    expect(job.metadata?.labels?.["correlation-id"]).toBeUndefined();
    expect(getEnvVar(getJobEnvVars(job), "KH_CORRELATION_ID")).toBeUndefined();
  });

  it("accepts a correlation id at the 63-character label limit", async () => {
    const atLimit = "a".repeat(63);
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "event",
      correlationId: atLimit,
    });

    const job = getSubmittedJob();
    expect(job.metadata?.labels?.["correlation-id"]).toBe(atLimit);
    expect(getEnvVar(getJobEnvVars(job), "KH_CORRELATION_ID")).toBe(atLimit);
  });

  it.each([
    ["one character over the limit", "a".repeat(64)],
    ["a leading separator", "-abcd1234"],
    ["a trailing separator", "abcd1234."],
    ["a trailing newline", "abcd1234\n"],
  ])("drops a correlation id with %s", async (_case, correlationId) => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "event",
      correlationId,
    });

    const job = getSubmittedJob();
    expect(job.metadata?.labels?.["correlation-id"]).toBeUndefined();
    expect(getEnvVar(getJobEnvVars(job), "KH_CORRELATION_ID")).toBeUndefined();
  });

  it("omits the latency env anchors when no stage stamps are supplied", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(envVars.find((v) => v.name === "KH_CORRELATION_ID")).toBeUndefined();
    expect(envVars.find((v) => v.name === "KH_RECEIVED_AT")).toBeUndefined();
    expect(envVars.find((v) => v.name === "KH_OBSERVED_AT")).toBeUndefined();
  });

  it("caps the runner heap below the container memory limit", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const job = getSubmittedJob();
    const heapCapMib = getHeapCapMib(getJobEnvVars(job));
    const limitMib = getMemoryLimitMib(job);

    // The kill lands on total RSS, so the heap cap has to leave room for the
    // off-heap allocations that sit alongside it, not merely undercut the limit.
    expect(heapCapMib).toBeLessThan(limitMib);
    expect(limitMib - heapCapMib).toBeGreaterThanOrEqual(256);
  });
});

describe("createWarmRunnerJob", () => {
  const warmParams = {
    token: "a".repeat(64),
    claimUrl: "http://10.0.0.5:3080",
    maxIdleMs: 815_000,
    preloadActionPrefixes: "web3/",
  };

  async function warmJob(): Promise<V1Job> {
    await createWarmRunnerJob(warmParams);
    return getSubmittedJob();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries no execution, workflow or organization data before a claim", async () => {
    const envVars = getJobEnvVars(await warmJob());
    for (const name of [
      "WORKFLOW_ID",
      "EXECUTION_ID",
      "WORKFLOW_INPUT",
      "TRIGGER_TYPE",
      "SCHEDULE_ID",
      "KH_CORRELATION_ID",
      "KH_RECEIVED_AT",
      "KH_OBSERVED_AT",
    ]) {
      expect(envVars.find((v) => v.name === name)).toBeUndefined();
    }
    expect(getEnvVar(envVars, "KH_WARM_POOL_CLAIM_URL")).toBe(
      "http://10.0.0.5:3080"
    );
    expect(getEnvVar(envVars, "KH_WARM_POOL_TOKEN")).toBe(warmParams.token);
  });

  it("never puts the claim token in the Job name or labels", async () => {
    const job = await warmJob();
    expect(job.metadata?.name).not.toContain(warmParams.token.slice(0, 8));
    const labelValues = [
      ...Object.values(job.metadata?.labels ?? {}),
      ...Object.values(job.spec?.template?.metadata?.labels ?? {}),
    ];
    expect(labelValues.join(" ")).not.toContain(warmParams.token);
  });

  it("keeps the runner label the network policy matches, and marks the pool", async () => {
    const job = await warmJob();
    const podLabels = job.spec?.template?.metadata?.labels ?? {};
    expect(podLabels.app).toBe("workflow-runner");
    expect(podLabels[WARM_POOL_LABEL]).toBe("true");
    expect(job.metadata?.name?.startsWith("keeperhub-workflow-")).toBe(true);
  });

  it("gets the same hardening and secret references as a per-run Job", async () => {
    const warm = await warmJob();
    vi.clearAllMocks();
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "block",
    });
    const cold = getSubmittedJob();

    const warmPod = warm.spec?.template?.spec;
    const coldPod = cold.spec?.template?.spec;
    expect(warmPod?.securityContext).toEqual(coldPod?.securityContext);
    expect(warmPod?.serviceAccountName).toBe(coldPod?.serviceAccountName);
    expect(warmPod?.automountServiceAccountToken).toBe(false);
    expect(warmPod?.volumes).toEqual(coldPod?.volumes);
    expect(warmPod?.containers?.[0]?.securityContext).toEqual(
      coldPod?.containers?.[0]?.securityContext
    );
    expect(warmPod?.containers?.[0]?.resources).toEqual(
      coldPod?.containers?.[0]?.resources
    );
    const secretRefs = (job: V1Job): string[] =>
      getJobEnvVars(job)
        .filter((v) => v.valueFrom?.secretKeyRef)
        .map((v) => v.name)
        .sort();
    expect(secretRefs(warm)).toEqual(secretRefs(cold));
  });

  it("covers the idle wait plus a full run, and caps the run from the claim", async () => {
    const job = await warmJob();
    expect(job.spec?.activeDeadlineSeconds).toBe(
      Math.ceil(warmParams.maxIdleMs / 1000) + CONFIG.jobActiveDeadline
    );
    expect(
      getEnvVar(getJobEnvVars(job), "KH_WARM_POOL_RUN_DEADLINE_MS")
    ).toBe(String(CONFIG.jobActiveDeadline * 1000));
  });
});

describe("getRunnerPodIps", () => {
  const job = { name: "keeperhub-workflow-warm-ab12-1", uid: "job-uid-1" };

  function pod(options: {
    phase?: string;
    ownerUid?: string;
    controller?: boolean;
    podIP?: string;
    podIPs?: string[];
  }): Record<string, unknown> {
    return {
      metadata: {
        ownerReferences: [
          {
            uid: options.ownerUid ?? job.uid,
            controller: options.controller ?? true,
          },
        ],
      },
      status: {
        phase: options.phase ?? "Running",
        podIP: options.podIP,
        podIPs: options.podIPs?.map((ip) => ({ ip })),
      },
    };
  }

  function podsAre(...items: Array<Record<string, unknown>>): void {
    mockListNamespacedPod.mockResolvedValueOnce({ items });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up the Job's pods by name in the runner namespace", async () => {
    podsAre(pod({ podIP: "10.1.2.3" }));
    await expect(getRunnerPodIps(job)).resolves.toEqual(["10.1.2.3"]);
    expect(mockListNamespacedPod).toHaveBeenCalledWith({
      namespace: "test-ns",
      labelSelector: `job-name=${job.name}`,
    });
  });

  it("returns every address of a dual-stack pod", async () => {
    podsAre(pod({ podIP: "10.1.2.3", podIPs: ["10.1.2.3", "fd00::12"] }));
    await expect(getRunnerPodIps(job)).resolves.toEqual([
      "10.1.2.3",
      "fd00::12",
    ]);
  });

  it("has no address while the pod is not running or has no IP", async () => {
    podsAre();
    await expect(getRunnerPodIps(job)).resolves.toBeUndefined();
    podsAre(pod({ phase: "Pending" }));
    await expect(getRunnerPodIps(job)).resolves.toBeUndefined();
    podsAre(pod({}));
    await expect(getRunnerPodIps(job)).resolves.toBeUndefined();
  });

  it("ignores a pod that only copies the job-name label", async () => {
    podsAre(pod({ ownerUid: "someone-else", podIP: "10.6.6.6" }));
    await expect(getRunnerPodIps(job)).resolves.toBeUndefined();
    podsAre(pod({ controller: false, podIP: "10.6.6.6" }));
    await expect(getRunnerPodIps(job)).resolves.toBeUndefined();
    podsAre(
      pod({ ownerUid: "someone-else", podIP: "10.6.6.6" }),
      pod({ podIP: "10.1.2.3" })
    );
    await expect(getRunnerPodIps(job)).resolves.toEqual(["10.1.2.3"]);
  });

  it("trusts no address when the Job somehow owns more than one running pod", async () => {
    podsAre(pod({ podIP: "10.1.2.3" }), pod({ podIP: "10.1.2.4" }));
    await expect(getRunnerPodIps(job)).resolves.toBeUndefined();
  });
});
