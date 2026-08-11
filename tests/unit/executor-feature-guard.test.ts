import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkWorkflowFeaturesForExecutor } from "@/keeperhub-executor/feature-guard";

type DbStub = PostgresJsDatabase<Record<string, unknown>>;

function makeDb(rows: Array<{ plan: string | null }>): DbStub {
  const builder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(builder),
  } as unknown as DbStub;
}

const databaseQueryNodeJson = {
  id: "node-db-1",
  data: { config: { actionType: "Database Query" } },
};

const conditionNodeJson = {
  id: "node-cond-1",
  data: { config: { actionType: "Condition" } },
};

// User-destination plugin action gated solely by its egress classification.
const blockscoutNodeJson = {
  id: "node-bs-1",
  data: { config: { actionType: "blockscout/get-address-balance" } },
};

const ORIGINAL_BILLING_FLAG = process.env.NEXT_PUBLIC_BILLING_ENABLED;

beforeEach(() => {
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
});

afterEach(() => {
  if (ORIGINAL_BILLING_FLAG === undefined) {
    delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = ORIGINAL_BILLING_FLAG;
  }
});

describe("checkWorkflowFeaturesForExecutor", () => {
  it("allows when billing is disabled regardless of nodes", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    const db = makeDb([]);

    const result = await checkWorkflowFeaturesForExecutor(db, "org_1", [
      databaseQueryNodeJson,
    ]);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.reason).toBe("billing_disabled");
    }
    expect(db.select).not.toHaveBeenCalled();
  });

  it("allows when workflow contains no gated nodes", async () => {
    const db = makeDb([{ plan: "free" }]);

    const result = await checkWorkflowFeaturesForExecutor(db, "org_1", [
      conditionNodeJson,
    ]);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.reason).toBe("no_violations");
    }
  });

  it("allows when org plan covers the gated feature", async () => {
    const db = makeDb([{ plan: "pro" }]);

    const result = await checkWorkflowFeaturesForExecutor(db, "org_1", [
      databaseQueryNodeJson,
    ]);

    expect(result.allowed).toBe(true);
  });

  it("blocks with violations when free org runs a gated workflow", async () => {
    const db = makeDb([{ plan: "free" }]);

    const result = await checkWorkflowFeaturesForExecutor(db, "org_1", [
      databaseQueryNodeJson,
    ]);

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.reason).toBe("upgrade_required");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].featureId).toBe("action.database-query");
    expect(result.violations[0].nodeIds).toEqual(["node-db-1"]);
  });

  it("blocks a user-destination plugin action (blockscout) for a free org at execute time", async () => {
    const db = makeDb([{ plan: "free" }]);

    const result = await checkWorkflowFeaturesForExecutor(db, "org_1", [
      blockscoutNodeJson,
    ]);

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.reason).toBe("upgrade_required");
    expect(result.violations[0].featureId).toBe("action.external-request");
    expect(result.violations[0].nodeIds).toEqual(["node-bs-1"]);
  });

  it("default-denies when org context is missing and a node is gated", async () => {
    const db = makeDb([]);

    const result = await checkWorkflowFeaturesForExecutor(db, null, [
      databaseQueryNodeJson,
    ]);

    expect(result.allowed).toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("allows missing-org callers when no node is gated", async () => {
    const db = makeDb([]);

    const result = await checkWorkflowFeaturesForExecutor(db, undefined, [
      conditionNodeJson,
    ]);

    expect(result.allowed).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("treats missing subscription row as free plan and blocks gated nodes", async () => {
    const db = makeDb([]); // no row returned

    const result = await checkWorkflowFeaturesForExecutor(db, "org_1", [
      databaseQueryNodeJson,
    ]);

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.violations[0].featureId).toBe("action.database-query");
  });
});
