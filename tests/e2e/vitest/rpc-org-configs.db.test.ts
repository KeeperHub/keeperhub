import "dotenv/config";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { member, organization, users, workflows } from "../../../lib/db/schema";
import {
  organizationRpcConfigs,
  organizationRpcUsageHourly,
} from "../../../lib/db/schema-rpc";
import { WorkflowTriggerEnum } from "../../../lib/workflow/store";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; these tests must write Postgres.
vi.unmock("@/lib/db");
// Every URL counts as answering for its chain; the live check has its own tests.
vi.mock("@/lib/rpc/engine/org/verify", () => ({
  verifyRpcConfigUrls: (urls: Record<string, string>) =>
    Promise.resolve({
      ok: true,
      verification: Object.fromEntries(
        Object.keys(urls).map((slot) => [
          slot,
          { ok: true, checkedAt: new Date(0).toISOString() },
        ])
      ),
    }),
}));

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = `rpc_${Date.now().toString(36)}_`;
const USER_ID = `${PREFIX}user`;
const ORG_ID = `${PREFIX}org`;
const SEPOLIA = 11_155_111;
const SECRET = "k3y0123456789abcdef0123456789abcd";

type Db = typeof import("@/lib/db").db;
type Service = typeof import("@/lib/rpc/engine/org/service");
type Runtime = typeof import("@/lib/rpc/engine/runtime");
type UsageStore = typeof import("@/lib/rpc/engine/usage-store");
type Types = typeof import("@/lib/rpc/engine/types");

let db: Db;
let service: Service;
let runtime: Runtime;
let usageStore: UsageStore;
let types: Types;

async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  const pattern = `${PREFIX}%`;
  try {
    await client.begin(async (tx) => {
      await tx`DELETE FROM workflows WHERE id LIKE ${pattern}`;
      await tx`DELETE FROM member WHERE organization_id LIKE ${pattern}`;
      await tx`DELETE FROM organization WHERE id LIKE ${pattern}`;
      await tx`DELETE FROM users WHERE id LIKE ${pattern}`;
    });
  } finally {
    await client.end();
  }
}

function urls(host: string) {
  return { httpPrimary: `https://${host}.example.com/v2/${SECRET}` };
}

async function createConfig(name: string, isDefault?: boolean) {
  const result = await service.createOrgRpcConfig({
    organizationId: ORG_ID,
    userId: USER_ID,
    chainId: SEPOLIA,
    name,
    urls: urls(name.toLowerCase()),
    isDefault,
  });
  if (!result.ok) {
    throw new Error(`create failed: ${result.code}`);
  }
  return result.config;
}

async function defaults(): Promise<string[]> {
  const rows = await db
    .select({ name: organizationRpcConfigs.name })
    .from(organizationRpcConfigs)
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, ORG_ID),
        eq(organizationRpcConfigs.isDefault, true)
      )
    );
  return rows.map((row) => row.name);
}

describe.skipIf(SKIP)("organization RPC configs (Postgres)", () => {
  beforeAll(async () => {
    await cleanup();
    vi.resetModules();
    ({ db } = await import("@/lib/db"));
    service = await import("@/lib/rpc/engine/org/service");
    runtime = await import("@/lib/rpc/engine/runtime");
    usageStore = await import("@/lib/rpc/engine/usage-store");
    types = await import("@/lib/rpc/engine/types");
    await db.insert(users).values({
      id: USER_ID,
      name: "rpc owner",
      email: `${PREFIX}@rpc.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organization).values({
      id: ORG_ID,
      name: "RPC",
      slug: ORG_ID.replaceAll("_", "-"),
      createdAt: new Date(),
    });
    await db.insert(member).values({
      id: `${PREFIX}member`,
      organizationId: ORG_ID,
      userId: USER_ID,
      role: "owner",
      createdAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  it("makes the first config on a chain its default and keeps one default", async () => {
    const main = await createConfig("Main");
    expect(main.isDefault).toBe(true);

    const archive = await createConfig("Archive");
    expect(archive.isDefault).toBe(false);

    const promoted = await service.updateOrgRpcConfig({
      organizationId: ORG_ID,
      userId: USER_ID,
      configId: archive.id,
      isDefault: true,
    });
    expect(promoted.ok).toBe(true);
    expect(await defaults()).toEqual(["Archive"]);
  });

  it("refuses a second config with the same name on a chain", async () => {
    const result = await service.createOrgRpcConfig({
      organizationId: ORG_ID,
      userId: USER_ID,
      chainId: SEPOLIA,
      name: "Main",
      urls: urls("dup"),
    });
    expect(result).toMatchObject({
      ok: false,
      code: service.OrgRpcErrorCode.NAME_TAKEN,
    });
  });

  it("stores URLs encrypted and lists them masked", async () => {
    const [row] = await db
      .select({ encryptedUrls: organizationRpcConfigs.encryptedUrls })
      .from(organizationRpcConfigs)
      .where(eq(organizationRpcConfigs.organizationId, ORG_ID))
      .limit(1);
    expect(row.encryptedUrls).not.toContain(SECRET);

    const listed = await service.listOrgRpcConfigs(ORG_ID);
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("serves the organization default to the resolver after a write", async () => {
    const state = await runtime.orgRpcSource.load(ORG_ID, SEPOLIA);
    const orgDefault = state.configs.find((config) => config.isDefault);
    expect(orgDefault?.name).toBe("Archive");
    expect(orgDefault?.httpPrimary.reveal()).toContain(SECRET);
  });

  it("refuses own RPC only while a workflow chain is not covered", async () => {
    await db.insert(workflows).values({
      id: `${PREFIX}wf_listen`,
      name: "Listener",
      userId: USER_ID,
      organizationId: ORG_ID,
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {
            type: "trigger",
            label: "Trigger",
            config: {
              triggerType: WorkflowTriggerEnum.BLOCK,
              network: String(SEPOLIA),
            },
          },
        },
      ],
      edges: [],
      enabled: true,
    });

    const refused = await service.setOrgRpcPolicy({
      organizationId: ORG_ID,
      userId: USER_ID,
      ownRpcOnly: true,
    });
    expect(refused).toMatchObject({
      ok: false,
      code: service.OrgRpcErrorCode.COVERAGE_GAPS,
      gaps: [expect.objectContaining({ nodeId: "trigger", chainId: SEPOLIA })],
    });

    const [archive] = (await service.listOrgRpcConfigs(ORG_ID)).filter(
      (config) => config.isDefault
    );
    const withSocket = await service.updateOrgRpcConfig({
      organizationId: ORG_ID,
      userId: USER_ID,
      configId: archive.id,
      urls: { wssPrimary: `wss://archive.example.com/v2/${SECRET}` },
    });
    expect(withSocket.ok).toBe(true);

    const accepted = await service.setOrgRpcPolicy({
      organizationId: ORG_ID,
      userId: USER_ID,
      ownRpcOnly: true,
    });
    expect(accepted).toMatchObject({ ok: true, policy: { ownRpcOnly: true } });
  });

  it("refuses to delete the config a workflow depends on", async () => {
    const [archive] = (await service.listOrgRpcConfigs(ORG_ID)).filter(
      (config) => config.isDefault
    );
    const result = await service.deleteOrgRpcConfig({
      organizationId: ORG_ID,
      configId: archive.id,
    });
    expect(result).toMatchObject({
      ok: false,
      code: service.OrgRpcErrorCode.COVERAGE_GAPS,
    });
  });

  it("adds usage counts across flushes, including KeeperHub rows", async () => {
    const accumulator = runtime.rpcUsageAccumulator;
    const key = {
      organizationId: ORG_ID,
      configId: null,
      origin: types.RpcOrigin.PLATFORM,
      chainId: SEPOLIA,
      transport: types.RpcTransport.HTTP,
    };
    accumulator.record(key, {
      requests: 2,
      latencyMsSum: 40,
      latencyMsMax: 30,
    });
    await usageStore.flushRpcUsage();
    accumulator.record(key, {
      requests: 3,
      latencyMsSum: 10,
      latencyMsMax: 10,
    });
    await usageStore.flushRpcUsage();

    const rows = await db
      .select()
      .from(organizationRpcUsageHourly)
      .where(eq(organizationRpcUsageHourly.organizationId, ORG_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requests: 5,
      latencyMsSum: 50,
      latencyMsMax: 30,
    });
  });
});
