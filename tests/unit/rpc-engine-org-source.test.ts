import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { rows } = vi.hoisted(() => ({
  rows: { policy: [] as unknown[], configs: [] as unknown[], selects: 0 },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (fields?: Record<string, unknown>) => {
      rows.selects += 1;
      const isPolicy = fields !== undefined && "ownRpcOnly" in fields;
      const result = isPolicy ? rows.policy : rows.configs;
      const where = {
        limit: () => Promise.resolve(result),
        // biome-ignore lint/suspicious/noThenProperty: the query builder is awaited directly
        then: (resolve: (value: unknown) => unknown) => resolve(result),
      };
      return { from: () => ({ where: () => where }) };
    },
  },
}));

import { createDbOrgRpcSource } from "@/lib/rpc/engine/sources/db-org-source";

describe("createDbOrgRpcSource", () => {
  beforeEach(() => {
    rows.policy = [];
    rows.configs = [];
    rows.selects = 0;
  });

  it("reads a policy change made elsewhere on the next load", async () => {
    const source = createDbOrgRpcSource();
    await expect(source.load("org_1", 1)).resolves.toMatchObject({
      policy: { ownRpcOnly: false },
    });

    rows.policy = [{ ownRpcOnly: true }];

    await expect(source.load("org_1", 1)).resolves.toMatchObject({
      policy: { ownRpcOnly: true },
    });
  });

  it("shares one read between concurrent loads of a chain", async () => {
    const source = createDbOrgRpcSource();
    const [first, second] = await Promise.all([
      source.load("org_1", 1),
      source.load("org_1", 1),
    ]);

    expect(first).toBe(second);
    expect(rows.selects).toBe(2);
  });
});
