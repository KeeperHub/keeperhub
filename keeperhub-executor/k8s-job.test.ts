import type { V1EnvVar, V1Job } from "@kubernetes/client-node";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

let mockCreateNamespacedJob: Mock;

vi.mock("@kubernetes/client-node", () => {
  mockCreateNamespacedJob = vi.fn().mockResolvedValue({
    metadata: { name: "workflow-test-123" },
  } as V1Job);

  class MockKubeConfig {
    loadFromDefault(): void {
      // no-op for test mock
    }
    makeApiClient(): { createNamespacedJob: Mock } {
      return { createNamespacedJob: mockCreateNamespacedJob };
    }
  }

  return {
    KubeConfig: MockKubeConfig,
    BatchV1Api: class {},
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

const { createWorkflowJob } = await import("./k8s-job");
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

  it("caps the runner heap below the container memory limit", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "NODE_OPTIONS")).toBe("--max-old-space-size=224");
  });
});
