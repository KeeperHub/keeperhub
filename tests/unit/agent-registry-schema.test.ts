import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentRegistrations } from "../../lib/db/schema";

describe("agentRegistrations table: v1.7 ERC-8004 schema", () => {
  const tableConfig = getTableConfig(agentRegistrations);

  it("has all required columns defined", () => {
    const columnNames = new Set(tableConfig.columns.map((col) => col.name));
    const requiredColumns = [
      "id",
      "agent_id",
      "tx_hash",
      "registered_at",
      "chain_id",
      "registry_address",
    ];
    for (const col of requiredColumns) {
      expect(columnNames.has(col)).toBe(true);
    }
  });

  it("id column is primary key", () => {
    const idCol = tableConfig.columns.find((c) => c.name === "id");
    expect(idCol).toBeDefined();
    expect(idCol?.primary).toBe(true);
  });

  it("agent_id column is notNull", () => {
    const agentIdCol = tableConfig.columns.find((c) => c.name === "agent_id");
    expect(agentIdCol).toBeDefined();
    expect(agentIdCol?.notNull).toBe(true);
  });

  it("tx_hash column is notNull", () => {
    const txHashCol = tableConfig.columns.find((c) => c.name === "tx_hash");
    expect(txHashCol).toBeDefined();
    expect(txHashCol?.notNull).toBe(true);
  });

  it("chain_id column has default value", () => {
    const chainIdCol = tableConfig.columns.find((c) => c.name === "chain_id");
    expect(chainIdCol).toBeDefined();
    expect(chainIdCol?.hasDefault).toBe(true);
  });
});
