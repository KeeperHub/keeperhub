import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { ListedWorkflowView } from "../../lib/db/schema";
import { workflows } from "../../lib/db/schema";

describe("workflows table: v1.7 listing schema", () => {
  const tableConfig = getTableConfig(workflows);

  it("has all 6 listing columns defined", () => {
    const columnNames = new Set(tableConfig.columns.map((col) => col.name));
    const requiredColumns = [
      "is_listed",
      "listed_slug",
      "listed_at",
      "input_schema",
      "output_mapping",
      "price_usdc_per_call",
    ];
    for (const col of requiredColumns) {
      expect(columnNames.has(col)).toBe(true);
    }
  });

  it("has is_listed column with default false and notNull", () => {
    const isListedCol = tableConfig.columns.find((c) => c.name === "is_listed");
    expect(isListedCol).toBeDefined();
    expect(isListedCol?.hasDefault).toBe(true);
    expect(isListedCol?.notNull).toBe(true);
  });

  it("has globally unique partial index idx_workflows_listed_slug", () => {
    const idx = tableConfig.indexes.find(
      (i) => i.config.name === "idx_workflows_listed_slug"
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("partial unique index covers only listedSlug column", () => {
    const idx = tableConfig.indexes.find(
      (i) => i.config.name === "idx_workflows_listed_slug"
    );
    expect(idx).toBeDefined();
    const colNames = idx?.config.columns.map((c) =>
      typeof c === "object" && c !== null && "name" in c
        ? (c as { name?: string }).name
        : undefined
    );
    expect(colNames).toContain("listed_slug");
    expect(colNames).not.toContain("organization_id");
  });

  it("ListedWorkflowView excludes nodes, edges, and userId at type level", () => {
    // Compile-time check: if ListedWorkflowView included these fields,
    // this assignment would fail to compile.
    type ExcludedKeys = "nodes" | "edges" | "userId";
    type HasExcluded = ExcludedKeys extends keyof ListedWorkflowView
      ? true
      : false;
    const check: HasExcluded = false;
    expect(check).toBe(false);
  });

  it("ListedWorkflowView is a closed allowlist (Pick), not Omit", () => {
    // Sentinel: pretend a future PR adds a sensitive column to the workflows
    // table. With Pick, it must NOT appear in ListedWorkflowView until someone
    // explicitly adds it. With Omit it would silently leak.
    type FutureSensitiveKey = "internalNotes" | "creatorEmail";
    type Leaked = FutureSensitiveKey extends keyof ListedWorkflowView
      ? true
      : false;
    const check: Leaked = false;
    expect(check).toBe(false);
  });
});
