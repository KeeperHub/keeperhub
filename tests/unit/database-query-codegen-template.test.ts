import { describe, expect, it, vi } from "vitest";
import blocklist from "@/lib/ssrf-blocklist.json" with { type: "json" };
import databaseQueryTemplate from "@/lib/workflow/codegen/templates/database-query";

// sdk.ts imports "server-only" at module load; stub for vitest.
vi.mock("server-only", () => ({}));

const { generateWorkflowSDKCode } = await import("@/lib/workflow/codegen/sdk");

import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// Mirrors lib/workflow/codegen/sdk.ts. If the SDK extractor changes, update
// this regex in lockstep so the template's guard logic is still emitted into
// exported workflows.
const FUNCTION_BODY_REGEX =
  /export\s+(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{([\s\S]*)\}/;

describe("database-query codegen template", () => {
  it("interpolates the canonical SSRF blocklist JSON, not a hand-rolled copy", () => {
    // Single source of truth: lib/ssrf-blocklist.json. Every entry in the
    // canonical JSON must appear verbatim in the emitted template; if a new
    // range is added to the JSON, this assertion catches divergence.
    const literal = JSON.stringify(blocklist);
    expect(databaseQueryTemplate).toContain(literal);
  });

  it("uses Node BlockList for CIDR checks (matches safe-fetch.ts pattern)", () => {
    expect(databaseQueryTemplate).toContain('await import("node:net")');
    expect(databaseQueryTemplate).toContain("new BlockList()");
    expect(databaseQueryTemplate).toContain(
      'blockList.addSubnet(addr, prefix, "ipv4")'
    );
    expect(databaseQueryTemplate).toContain(
      'blockList.addSubnet(addr, prefix, "ipv6")'
    );
  });

  it("includes hostname pre-DNS denylist using JSON-sourced exact/suffix sets", () => {
    expect(databaseQueryTemplate).toContain("SSRF_BLOCKLIST.blockedHostExact");
    expect(databaseQueryTemplate).toContain(
      "SSRF_BLOCKLIST.blockedHostSuffixes"
    );
  });

  it("returns the canonical error string used by lib/db/connection-host-guard", () => {
    expect(databaseQueryTemplate).toContain(
      "Host is not allowed: must resolve to a public address"
    );
    expect(databaseQueryTemplate).toContain(
      "Connection string is missing a host"
    );
    expect(databaseQueryTemplate).toContain("Host could not be resolved");
  });

  it("runs the guard before any postgres connection is opened", () => {
    const postgresIdx = databaseQueryTemplate.indexOf(
      "postgres.default(databaseUrl"
    );
    const guardIdx = databaseQueryTemplate.indexOf("isBlockedHostname(host)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(postgresIdx).toBeGreaterThan(guardIdx);
  });

  it("is still extractable by the SDK function-body regex", () => {
    const match = databaseQueryTemplate.match(FUNCTION_BODY_REGEX);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? "";
    expect(body).toContain("SSRF_BLOCKLIST");
    expect(body).toContain("postgres.default(databaseUrl");
  });

  it("emits the guard into generated SDK code for a Database Query node", () => {
    const trigger: WorkflowNode = {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        type: "trigger",
        label: "Manual Trigger",
        config: { triggerType: "Manual" },
      },
    };
    const dbNode: WorkflowNode = {
      id: "db-1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        type: "action",
        label: "Database Query",
        config: {
          actionType: "Database Query",
          dbQuery: "SELECT 1",
        },
      },
    };
    const edge: WorkflowEdge = {
      id: "trigger-1-db-1",
      source: "trigger-1",
      target: "db-1",
    };

    const code = generateWorkflowSDKCode(
      "db_query_workflow",
      [trigger, dbNode],
      [edge]
    );

    // The canonical JSON literal is embedded in the emitted workflow.
    expect(code).toContain(JSON.stringify(blocklist));
    // Guard precedes the postgres call.
    const guardIdx = code.indexOf("isBlockedHostname(host)");
    const postgresIdx = code.indexOf("postgres.default(databaseUrl");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(postgresIdx).toBeGreaterThan(guardIdx);
  });
});
