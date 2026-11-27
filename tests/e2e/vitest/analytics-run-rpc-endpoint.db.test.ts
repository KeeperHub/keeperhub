import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  FacetDimension,
  RunFacets,
  RunQueryFilters,
  StepLog,
  UnifiedRun,
} from "../../../lib/analytics/types";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";
import { directExecutions } from "../../../lib/db/schema-extensions";
import { organizationRpcConfigs } from "../../../lib/db/schema-rpc";
import { RpcOrigin, RpcRoutePosition } from "../../../lib/rpc/engine/types";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; the filter under test runs in Postgres.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = `test_run_rpc_${Date.now().toString(36)}_`;
const ORG_ID = `${PREFIX}org`;
const OTHER_ORG_ID = `${PREFIX}other`;
const USER_ID = `${PREFIX}user`;
const WORKFLOW_ID = `${PREFIX}wf`;
const MAIN_CONFIG = `${PREFIX}cfg_main`;
const ARCHIVE_CONFIG = `${PREFIX}cfg_archive`;
const REMOVED_CONFIG = `${PREFIX}cfg_removed`;

type Served = { origin: RpcOrigin; configId: string | null };

const OWN_MAIN: Served = { origin: RpcOrigin.ORG, configId: MAIN_CONFIG };
const OWN_ARCHIVE: Served = { origin: RpcOrigin.ORG, configId: ARCHIVE_CONFIG };
const OWN_REMOVED: Served = { origin: RpcOrigin.ORG, configId: REMOVED_CONFIG };
const PLATFORM: Served = { origin: RpcOrigin.PLATFORM, configId: null };

// One run per case, each step naming the endpoint that served it.
const RUNS: Record<string, Array<Served | null>> = {
  own: [OWN_MAIN],
  mixed: [OWN_MAIN, PLATFORM],
  archive: [OWN_ARCHIVE],
  removed: [OWN_REMOVED],
  platform: [PLATFORM, null],
  none: [null],
};

const runId = (name: string): string => `${PREFIX}${name}`;
const directId = (name: string): string => `${PREFIX}direct_${name}`;

type GetUnifiedRuns = (
  organizationId: string,
  range: "7d",
  options?: RunQueryFilters & { limit?: number }
) => Promise<{ runs: UnifiedRun[] }>;
type GetStepLogs = (
  executionId: string,
  organizationId: string
) => Promise<StepLog[]>;
type GetRunFacets = (
  organizationId: string,
  range: "7d",
  options?: RunQueryFilters & { dimensions?: FacetDimension[] }
) => Promise<RunFacets>;

describe.skipIf(SKIP)("analytics runs by rpc endpoint", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getUnifiedRuns: GetUnifiedRuns;
  let getRunFacets: GetRunFacets;
  let getStepLogs: GetStepLogs;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM direct_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function idsFor(rpcEndpoints: string[]): Promise<string[]> {
    const { runs } = await getUnifiedRuns(ORG_ID, "7d", {
      rpcEndpoints,
      limit: 50,
    });
    return runs.map((run) => run.id).sort();
  }

  beforeAll(async () => {
    process.env.ANALYTICS_CACHE_TTL_MS = "0";
    queryClient = postgres(DATABASE_URL, { max: 2 });
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();
    await db.insert(organization).values([
      { id: ORG_ID, name: "rpc runs org", slug: ORG_ID, createdAt: now },
      {
        id: OTHER_ORG_ID,
        name: "rpc runs other",
        slug: OTHER_ORG_ID,
        createdAt: now,
      },
    ]);
    await db.insert(users).values({
      id: USER_ID,
      email: `${USER_ID}@keeperhub.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organizationRpcConfigs).values([
      {
        id: MAIN_CONFIG,
        organizationId: ORG_ID,
        chainId: 1,
        name: "Mainnet main",
        encryptedUrls: "unused",
      },
      {
        id: ARCHIVE_CONFIG,
        organizationId: ORG_ID,
        chainId: 1,
        name: "Mainnet archive",
        encryptedUrls: "unused",
      },
    ]);
    await db.insert(workflows).values([
      {
        id: WORKFLOW_ID,
        name: "Read balances",
        userId: USER_ID,
        organizationId: ORG_ID,
        enabled: true,
        nodes: [],
        edges: [],
      },
      {
        id: `${PREFIX}wf_other`,
        name: "Neighbour",
        userId: USER_ID,
        organizationId: OTHER_ORG_ID,
        enabled: true,
        nodes: [],
        edges: [],
      },
    ]);

    const runs = [
      ...Object.keys(RUNS).map((name) => ({
        id: runId(name),
        workflowId: WORKFLOW_ID,
      })),
      { id: runId("neighbour"), workflowId: `${PREFIX}wf_other` },
    ];
    await db.insert(workflowExecutions).values(
      runs.map((run) => ({
        ...run,
        userId: USER_ID,
        status: "success" as const,
        duration: "1000",
        startedAt: now,
        completedAt: now,
      }))
    );

    const steps = [
      ...Object.entries(RUNS).flatMap(([name, served]) =>
        served.map((endpoint, index) => ({ name, endpoint, index }))
      ),
      // Another organization's run on one of this org's config ids.
      { name: "neighbour", endpoint: OWN_MAIN, index: 0 },
    ];
    await db.insert(workflowExecutionLogs).values(
      steps.map(({ name, endpoint, index }) => ({
        id: `${runId(name)}_log${String(index)}`,
        executionId: runId(name),
        nodeId: `n${String(index)}`,
        nodeName: "Step",
        nodeType: "web3/check-balance",
        status: "success" as const,
        rpcOrigin: endpoint?.origin ?? null,
        rpcConfigId: endpoint?.configId ?? null,
        rpcFailedOver: endpoint ? false : null,
        rpcEndpoints: endpoint
          ? [
              {
                origin: endpoint.origin,
                configId: endpoint.configId,
                position: RpcRoutePosition.PRIMARY,
                requests: 2,
                errors: 0,
              },
            ]
          : null,
        startedAt: now,
      }))
    );

    await db.insert(directExecutions).values(
      [
        { name: "own", served: OWN_MAIN, org: ORG_ID },
        { name: "platform", served: PLATFORM, org: ORG_ID },
        { name: "neighbour", served: OWN_MAIN, org: OTHER_ORG_ID },
      ].map(({ name, served, org }) => ({
        id: directId(name),
        organizationId: org,
        apiKeyId: `${PREFIX}key`,
        type: "check-balance",
        status: "completed",
        rpcOrigin: served.origin,
        rpcConfigId: served.configId,
        rpcFailedOver: false,
        createdAt: now,
      }))
    );

    ({ getUnifiedRuns, getRunFacets, getStepLogs } = await import(
      "@/lib/analytics/queries"
    ));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
    process.env.ANALYTICS_CACHE_TTL_MS = undefined;
  });

  it("lists runs any of the organization's endpoints served", async () => {
    expect(await idsFor([RpcOrigin.ORG])).toEqual(
      [
        runId("archive"),
        runId("mixed"),
        runId("own"),
        runId("removed"),
        directId("own"),
      ].sort()
    );
  });

  it("lists runs KeeperHub's endpoints served", async () => {
    expect(await idsFor([RpcOrigin.PLATFORM])).toEqual(
      [runId("mixed"), runId("platform"), directId("platform")].sort()
    );
  });

  it("lists the runs one config served", async () => {
    expect(await idsFor([MAIN_CONFIG])).toEqual(
      [runId("mixed"), runId("own"), directId("own")].sort()
    );
    expect(await idsFor([ARCHIVE_CONFIG])).toEqual([runId("archive")]);
  });

  it("unions several endpoints", async () => {
    expect(await idsFor([ARCHIVE_CONFIG, RpcOrigin.PLATFORM])).toEqual(
      [
        runId("archive"),
        runId("mixed"),
        runId("platform"),
        directId("platform"),
      ].sort()
    );
  });

  it("counts runs per endpoint and names the configs that still exist", async () => {
    const facets = await getRunFacets(ORG_ID, "7d", { dimensions: ["rpc"] });
    expect(facets.rpcEndpointCounts).toEqual({
      [RpcOrigin.ORG]: 5,
      [RpcOrigin.PLATFORM]: 3,
      [MAIN_CONFIG]: 3,
      [ARCHIVE_CONFIG]: 1,
      [REMOVED_CONFIG]: 1,
    });
    expect(facets.rpcConfigNames).toEqual({
      [MAIN_CONFIG]: "Mainnet main",
      [ARCHIVE_CONFIG]: "Mainnet archive",
    });
  });

  it("lifts its own dimension but keeps the others", async () => {
    const facets = await getRunFacets(ORG_ID, "7d", {
      dimensions: ["rpc"],
      rpcEndpoints: [ARCHIVE_CONFIG],
      sources: ["direct"],
    });
    expect(facets.rpcEndpointCounts).toEqual({
      [RpcOrigin.ORG]: 1,
      [RpcOrigin.PLATFORM]: 1,
      [MAIN_CONFIG]: 1,
    });
  });

  it("leaves the endpoint counts empty unless asked for", async () => {
    const facets = await getRunFacets(ORG_ID, "7d");
    expect(facets.rpcEndpointCounts).toEqual({});
    expect(facets.rpcConfigNames).toEqual({});
  });

  it("names each endpoint a step reached in the run details", async () => {
    const steps = await getStepLogs(runId("mixed"), ORG_ID);
    expect(
      steps.map((step) =>
        step.rpcEndpoints.map((usage) => [usage.origin, usage.configName])
      )
    ).toEqual([
      [[RpcOrigin.ORG, "Mainnet main"]],
      [[RpcOrigin.PLATFORM, null]],
    ]);
    const removed = await getStepLogs(runId("removed"), ORG_ID);
    expect(removed[0]?.rpcEndpoints[0]?.configName).toBeNull();
    expect(removed[0]?.rpcConfigName).toBeNull();
  });

  it("shows another organization's run details nothing", async () => {
    expect(await getStepLogs(runId("neighbour"), ORG_ID)).toEqual([]);
  });
});
