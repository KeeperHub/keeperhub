/**
 * The Condition group migration against a real Postgres.
 *
 * tests/unit/migration-*-condition-group-to-condition-config.test.ts asserts
 * the text of the SQL, which passes on any file carrying the same substrings
 * and breaks on harmless reformatting. This runs it. Every arm of the inner
 * CASE gets a node shaped for it, in one `nodes` array so node order is under
 * test too, and the whitespace arm is here because that one was a live defect:
 * a condition of spaces reads as present to `<> ''` and as absent to
 * `resolveConditionExpression`, so without btrim the rule group is deleted
 * with nothing promoted in its place.
 */

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization, users, workflows } from "../../lib/db/schema";

vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_cond_group_";
const USER = `${PREFIX}user`;
const ORG = `${PREFIX}org`;
const WORKFLOW = `${PREFIX}wf`;
// Carries no Condition group, so the statement must not write it at all.
const UNTOUCHED = `${PREFIX}wf_untouched`;
const NOW = new Date("2026-09-09T12:00:00.000Z");

const RULES = {
  id: "group-1",
  logic: "AND",
  rules: [{ id: "rule-1", leftOperand: "a", operator: "<", rightOperand: "2" }],
};
const OTHER_RULES = { id: "group-2", logic: "OR", rules: [] };

/** The statements of this branch's migration, found by name rather than number. */
function conditionGroupMigration(): string[] {
  const dir = path.resolve(process.cwd(), "drizzle");
  const file = readdirSync(dir).find((name) =>
    name.endsWith("_keep_2305_condition_group_to_condition_config.sql")
  );
  if (!file) {
    throw new Error("the condition-group migration is gone");
  }
  return readFileSync(path.join(dir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const node = (
  id: string,
  actionType: string,
  config: Record<string, unknown>
) => ({ id, type: "custom", data: { config: { actionType, ...config } } });

/** One node per arm, in an order the migration has to preserve. */
const SEEDED = [
  node("n1-expression", "Condition", {
    condition: "a < 2",
    group: RULES,
  }),
  node("n2-whitespace", "Condition", {
    condition: "   ",
    group: RULES,
  }),
  // One-argument btrim strips spaces only. These two are what it missed.
  node("n2b-newline", "Condition", {
    condition: "\n",
    group: RULES,
  }),
  node("n2c-mixed-whitespace", "Condition", {
    condition: "\t\r\n\v\f ",
    group: RULES,
  }),
  // Not blank. A set written with \v instead of \x0b strips the letter v,
  // and would promote this node's group over a real expression.
  node("n2d-letter-v", "Condition", {
    condition: "v",
    group: RULES,
  }),
  node("n3-bare", "Condition", { group: RULES }),
  node("n4-merge", "Condition", {
    group: RULES,
    conditionConfig: { negate: true },
  }),
  node("n5-existing-group", "Condition", {
    group: RULES,
    conditionConfig: { group: OTHER_RULES },
  }),
  node("n6-scalar-config", "Condition", {
    group: RULES,
    conditionConfig: "not an object",
  }),
  node("n7-not-a-condition", "http/request", { group: RULES }),
];

type NodeRow = {
  id: string;
  data: { config: Record<string, unknown> };
};

describe("condition group moves under conditionConfig (real database)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let statements: string[];

  async function cleanup(): Promise<void> {
    const like = `${PREFIX}%`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${like}`;
  }

  async function runMigration(): Promise<void> {
    for (const statement of statements) {
      await queryClient.unsafe(statement);
    }
  }

  async function readNodes(): Promise<NodeRow[]> {
    const rows = await queryClient`
        SELECT nodes FROM workflows WHERE id = ${WORKFLOW}`;
    return rows[0]?.nodes as NodeRow[];
  }

  async function readUpdatedAt(): Promise<string> {
    const rows = await queryClient`
        SELECT updated_at FROM workflows WHERE id = ${WORKFLOW}`;
    return String(rows[0]?.updated_at);
  }

  /**
   * The transaction id that last wrote the row. A statement that rebuilds an
   * array to an identical value still writes the row and moves this, which a
   * check on the contents cannot see.
   */
  async function readXmin(id: string): Promise<string> {
    const rows = await queryClient`
        SELECT xmin::text AS xmin FROM workflows WHERE id = ${id}`;
    return String(rows[0]?.xmin);
  }

  const configOf = (nodes: NodeRow[], id: string): Record<string, unknown> => {
    const found = nodes.find((n) => n.id === id);
    if (!found) {
      throw new Error(`node ${id} is gone`);
    }
    return found.data.config;
  };

  beforeAll(async () => {
    // Checked before new URL(), which would otherwise throw "Invalid URL" and
    // hide the reason.
    if (!DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set; this file needs a local Postgres"
      );
    }
    const host = new URL(DATABASE_URL).hostname;
    if (!["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host)) {
      throw new Error(`refusing to run against a non-local database: ${host}`);
    }
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    statements = conditionGroupMigration();

    await cleanup();
    await db.insert(users).values({
      id: USER,
      name: "condition group probe",
      email: `${PREFIX}probe@keeperhub.test`,
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db
      .insert(organization)
      .values({ id: ORG, name: ORG, slug: ORG, createdAt: NOW });
    await db.insert(workflows).values({
      id: WORKFLOW,
      name: "condition group workflow",
      userId: USER,
      organizationId: ORG,
      nodes: SEEDED,
      edges: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(workflows).values({
      id: UNTOUCHED,
      name: "workflow with no condition group",
      userId: USER,
      organizationId: ORG,
      nodes: [node("u1", "http/request", { url: "https://example.com" })],
      edges: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("moves, merges or drops the group once per arm", async () => {
    const before = await readUpdatedAt();
    const untouchedBefore = await readXmin(UNTOUCHED);
    await runMigration();
    const nodes = await readNodes();

    // Order is part of the contract: the subquery rebuilds the array.
    expect(nodes.map((n) => n.id)).toEqual(SEEDED.map((n) => n.id));

    // An expression already decides this node, so the stale group is only
    // removed - promoting it would change which rules run.
    expect(configOf(nodes, "n1-expression")).toEqual({
      actionType: "Condition",
      condition: "a < 2",
    });

    // The blocker this file exists for. A condition of spaces is absent to
    // resolveConditionExpression, so the group is the only rules this node
    // has and has to be promoted, not dropped.
    expect(configOf(nodes, "n2-whitespace")).toEqual({
      actionType: "Condition",
      condition: "   ",
      conditionConfig: { group: RULES },
    });

    // Same arm, whitespace btrim(text) alone would not strip. Measured on 16.14
    // by the review: without the character set these came out with their
    // group deleted and nothing promoted.
    expect(configOf(nodes, "n2b-newline")).toEqual({
      actionType: "Condition",
      condition: "\n",
      conditionConfig: { group: RULES },
    });
    expect(configOf(nodes, "n2c-mixed-whitespace")).toEqual({
      actionType: "Condition",
      condition: "\t\r\n\v\f ",
      conditionConfig: { group: RULES },
    });

    // "v" is an expression, so the group is only removed. Postgres has no \v
    // escape; a set that relied on one would have stripped this to nothing.
    expect(configOf(nodes, "n2d-letter-v")).toEqual({
      actionType: "Condition",
      condition: "v",
    });

    expect(configOf(nodes, "n3-bare")).toEqual({
      actionType: "Condition",
      conditionConfig: { group: RULES },
    });

    expect(configOf(nodes, "n4-merge")).toEqual({
      actionType: "Condition",
      conditionConfig: { negate: true, group: RULES },
    });

    // An existing group wins outright; the stale one is discarded.
    expect(configOf(nodes, "n5-existing-group")).toEqual({
      actionType: "Condition",
      conditionConfig: { group: OTHER_RULES },
    });

    expect(configOf(nodes, "n6-scalar-config")).toEqual({
      actionType: "Condition",
      conditionConfig: { group: RULES },
    });

    // Not a Condition node: untouched, group and all.
    expect(configOf(nodes, "n7-not-a-condition")).toEqual({
      actionType: "http/request",
      group: RULES,
    });

    // A repair is not a user edit.
    expect(await readUpdatedAt()).toBe(before);

    // A row with no Condition group is not written at all. This is what the
    // EXISTS qualifier is for, and the lost-update window is about exactly
    // this set of rows.
    expect(await readXmin(UNTOUCHED)).toBe(untouchedBefore);
  });

  it("is idempotent, and a second run writes nothing", async () => {
    const first = await readNodes();
    const writtenBy = await readXmin(WORKFLOW);
    await runMigration();
    expect(await readNodes()).toEqual(first);
    // Content alone would pass even if every row were rewritten to the same
    // value; the row not being written is what UPDATE 0 means.
    expect(await readXmin(WORKFLOW)).toBe(writtenBy);
  });
});
