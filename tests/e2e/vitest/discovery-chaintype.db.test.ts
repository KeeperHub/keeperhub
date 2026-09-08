import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chains, organization, users, workflows } from "../../../lib/db/schema";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db; this suite needs the real route
// handlers to hit Postgres so the chainType SQL/filter is exercised end to end.
vi.unmock("@/lib/db");

// This suite covers the chainType filter, not auth.
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: () => ({
    authenticated: true,
    service: "events" as const,
  }),
}));

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_keep987_disc_";
const EVM_CHAIN = 999_001;
const SOLANA_CHAIN = 999_101;

type Handler = (request: Request) => Promise<Response>;

function req(path: string, chainType?: string): Request {
  const suffix = chainType ? `&chainType=${chainType}` : "";
  return new Request(`http://localhost${path}?active=true${suffix}`, {
    method: "GET",
  });
}

/** Returns the IDs of this suite's seeded workflows present in the response. */
async function seededIds(response: Response): Promise<string[]> {
  const body = (await response.json()) as { workflows: { id: string }[] };
  return body.workflows
    .map((w) => w.id)
    .filter((id) => id.startsWith(PREFIX))
    .sort();
}

function triggerNode(triggerType: string, network: string): unknown {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      type: "trigger",
      label: "Trigger",
      config: { triggerType, network },
    },
  };
}

describe.skipIf(SKIP)(
  "discovery chainType filter - real-DB integration",
  () => {
    let queryClient: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle>;
    let eventsGET: Handler;
    let blockGET: Handler;

    async function cleanup(): Promise<void> {
      await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM chains WHERE id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    }

    beforeAll(async () => {
      queryClient = postgres(DATABASE_URL);
      db = drizzle(queryClient);
      await cleanup();

      const now = new Date();
      const orgId = `${PREFIX}org`;
      const userId = `${PREFIX}user`;

      await db.insert(organization).values({
        id: orgId,
        name: "keep987 disc org",
        slug: orgId,
        createdAt: now,
      });
      await db.insert(users).values({
        id: userId,
        email: `${userId}@keep987.test`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(chains).values([
        {
          id: `${PREFIX}evm`,
          chainId: EVM_CHAIN,
          name: "Disc EVM",
          symbol: "ETH",
          chainType: "evm",
          defaultPrimaryRpc: "http://rpc.test",
        },
        {
          id: `${PREFIX}solana`,
          chainId: SOLANA_CHAIN,
          name: "Disc Solana",
          symbol: "SOL",
          chainType: "solana",
          defaultPrimaryRpc: "http://rpc.test",
        },
      ]);

      const wf = (id: string, triggerType: string, network: string) => ({
        id: `${PREFIX}${id}`,
        name: `${PREFIX}${id}`,
        userId,
        organizationId: orgId,
        enabled: true,
        nodes: [triggerNode(triggerType, network)],
        edges: [],
      });

      await db
        .insert(workflows)
        .values([
          wf("evm_event", "Event", String(EVM_CHAIN)),
          wf("solana_event", "Event", String(SOLANA_CHAIN)),
          wf("evm_block", "Block", String(EVM_CHAIN)),
          wf("solana_block", "Block", String(SOLANA_CHAIN)),
        ]);

      ({ GET: eventsGET } = await import("@/app/api/workflows/events/route"));
      ({ GET: blockGET } = await import(
        "@/app/api/internal/block-workflows/route"
      ));
    });

    afterAll(async () => {
      await cleanup();
      await queryClient.end();
    });

    it("event route: default returns EVM-network event workflows, not Solana", async () => {
      expect(
        await seededIds(await eventsGET(req("/api/workflows/events")))
      ).toEqual([`${PREFIX}evm_event`]);
    });

    it("event route: chainType=solana returns only Solana-network event workflows", async () => {
      expect(
        await seededIds(await eventsGET(req("/api/workflows/events", "solana")))
      ).toEqual([`${PREFIX}solana_event`]);
    });

    it("block route: default returns EVM-network block workflows, not Solana", async () => {
      expect(
        await seededIds(await blockGET(req("/api/internal/block-workflows")))
      ).toEqual([`${PREFIX}evm_block`]);
    });

    it("block route: chainType=solana returns only Solana-network block workflows", async () => {
      expect(
        await seededIds(
          await blockGET(req("/api/internal/block-workflows", "solana"))
        )
      ).toEqual([`${PREFIX}solana_block`]);
    });
  }
);
