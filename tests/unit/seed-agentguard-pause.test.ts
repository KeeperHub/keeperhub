import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// drizzles uses these at module scope; keep them as no-ops so importing the
// seeder does not try to touch a real DB in the unit test pool.
vi.mock("dotenv/config", () => ({}));
vi.mock("postgres", () => {
  return { default: () => ({ end: vi.fn() }) };
});

const {
  mockSelect,
  mockInsert,
  mockUpdate,
  mockFrom,
  mockWhere,
  mockLimit,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockFrom: vi.fn(),
  mockWhere: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { id: "workflows.id", name: "workflows.name" },
  users: { id: "users.id" },
  member: { organizationId: "member.organizationId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

// The seeder imports drizzle from here at module scope; the unit test never
// calls main() (so drizzle() is never invoked), but mocking the module keeps
// importing the seeder free of postgres-js side effects in the test pool.
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: () => ({}) as never,
}));

vi.mock("../../lib/db/connection-utils", () => ({
  getDatabaseUrl: () => "postgres://mock",
}));

import {
  AGENTGUARD_PAUSE_FIXTURES,
  type AgentGuardPauseFixture,
} from "@/scripts/seed/fixtures/agentguard-pause";
import {
  USER_EDIT_EPSILON_MS,
  seedAgentGuardPause,
} from "@/scripts/seed/seed-agentguard-pause";

// A drizzle-shaped db whose select/insert/update chain is fully mocked.
function makeDb(existingRows: unknown[]) {
  mockSelect.mockReturnValue({
    from: mockFrom,
  });
  mockFrom.mockReturnValue({
    where: mockWhere,
  });
  mockWhere.mockReturnValue({
    limit: mockLimit,
  });
  mockLimit.mockResolvedValue(existingRows);

  mockInsert.mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  });
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });

  return {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  };
}

const IDENTITY = { userId: "user-1", orgId: "org-1" };

describe("AGENTGUARD_PAUSE_FIXTURES", () => {
  it("has exactly one fixture", () => {
    expect(AGENTGUARD_PAUSE_FIXTURES).toHaveLength(1);
  });

  it("has unique ids and listedSlugs", () => {
    const ids = AGENTGUARD_PAUSE_FIXTURES.map((f) => f.id);
    const slugs = AGENTGUARD_PAUSE_FIXTURES.map((f) => f.listedSlug);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  for (const fixture of AGENTGUARD_PAUSE_FIXTURES) {
    describe(`fixture: ${fixture.id}`, () => {
      it("has required string fields", () => {
        expect(typeof fixture.id).toBe("string");
        expect(typeof fixture.listedSlug).toBe("string");
        expect(typeof fixture.name).toBe("string");
        expect(typeof fixture.description).toBe("string");
        expect(typeof fixture.featuredProtocol).toBe("string");
        expect(fixture.id.length).toBeGreaterThan(0);
        expect(fixture.listedSlug.length).toBeGreaterThan(0);
        expect(fixture.name.length).toBeGreaterThan(0);
      });

      it("has at least one node and one edge", () => {
        expect((fixture.nodes as unknown[]).length).toBeGreaterThan(0);
        expect((fixture.edges as unknown[]).length).toBeGreaterThan(0);
      });

      it("edge source and target IDs reference existing nodes", () => {
        type NodeLike = { id: string };
        type EdgeLike = { source: string; target: string };
        const nodeIds = new Set(
          (fixture.nodes as NodeLike[]).map((n) => n.id)
        );
        for (const edge of fixture.edges as EdgeLike[]) {
          expect(
            nodeIds.has(edge.source),
            `edge source "${edge.source}" missing from nodes`
          ).toBe(true);
          expect(
            nodeIds.has(edge.target),
            `edge target "${edge.target}" missing from nodes`
          ).toBe(true);
        }
      });

      it("first node is a Manual trigger", () => {
        type NodeLike = {
          id: string;
          data?: { config?: { triggerType?: string } };
        };
        const first = (fixture.nodes as NodeLike[])[0];
        expect(first.id).toBe("trigger-1");
        expect(first.data?.config?.triggerType).toBe("Manual");
      });

      it("pause action targets an empty contract address by default", () => {
        type NodeLike = {
          id: string;
          data?: {
            config?: {
              actionType?: string;
              abiFunction?: string;
              contractAddress?: string;
            };
          };
        };
        const pause = (fixture.nodes as NodeLike[]).find(
          (n) => n.id === "step-1"
        );
        expect(pause?.data?.config?.actionType).toBe("web3/write-contract");
        expect(pause?.data?.config?.abiFunction).toBe("pause");
        expect(pause?.data?.config?.contractAddress).toBe("");
      });
    });
  }
});

describe("USER_EDIT_EPSILON_MS", () => {
  it("is 5000 ms", () => {
    expect(USER_EDIT_EPSILON_MS).toBe(5000);
  });
});

describe("seedAgentGuardPause", () => {
  const FIXTURE = AGENTGUARD_PAUSE_FIXTURES[0] as AgentGuardPauseFixture;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts the fixture when the workflow does not exist (created)", async () => {
    const db = makeDb([]);
    const result = await seedAgentGuardPause(
      db as never,
      IDENTITY
    );

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ created: 1, refreshed: 0, skipped: 0 });
  });

  it("refreshes the fixture when it was seeded and not user-edited (refreshed)", async () => {
    const seededAt = new Date();
    const updatedAt = new Date(seededAt.getTime() + 1_000); // within epsilon
    const db = makeDb([
      {
        id: FIXTURE.id,
        updatedAt,
        seededAt,
        deletedAt: null,
      },
    ]);

    const result = await seedAgentGuardPause(
      db as never,
      IDENTITY
    );

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ created: 0, refreshed: 1, skipped: 0 });
  });

  it("skips when seededAt is null (not seeded by this script)", async () => {
    const db = makeDb([
      {
        id: FIXTURE.id,
        updatedAt: new Date(),
        seededAt: null,
        deletedAt: null,
      },
    ]);

    const result = await seedAgentGuardPause(
      db as never,
      IDENTITY
    );

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, refreshed: 0, skipped: 1 });
  });

  it("skips when the user edited the workflow (updatedAt beyond epsilon)", async () => {
    const seededAt = new Date("2026-01-01T00:00:00Z");
    const updatedAt = new Date(seededAt.getTime() + 60_000); // beyond epsilon
    const db = makeDb([
      {
        id: FIXTURE.id,
        updatedAt,
        seededAt,
        deletedAt: null,
      },
    ]);

    const result = await seedAgentGuardPause(
      db as never,
      IDENTITY
    );

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, refreshed: 0, skipped: 1 });
  });
});
