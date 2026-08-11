import { describe, expect, it, vi } from "vitest";

// queries.ts is a server-only module that also pulls in the db client; stub
// both so the pure status helpers can be imported under vitest without
// resolving the server-only marker or opening a DB connection.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { normalizeStatus, workflowDbStatuses } from "@/lib/analytics/queries";

describe("normalizeStatus", () => {
  it("maps phantom workflow runs to pending", () => {
    expect(normalizeStatus("phantom", "workflow")).toBe("pending");
  });

  it("passes through the standard workflow statuses unchanged", () => {
    expect(normalizeStatus("pending", "workflow")).toBe("pending");
    expect(normalizeStatus("running", "workflow")).toBe("running");
    expect(normalizeStatus("success", "workflow")).toBe("success");
    expect(normalizeStatus("error", "workflow")).toBe("error");
    expect(normalizeStatus("cancelled", "workflow")).toBe("cancelled");
  });

  it("maps direct completed/failed onto success/error", () => {
    expect(normalizeStatus("completed", "direct")).toBe("success");
    expect(normalizeStatus("failed", "direct")).toBe("error");
  });

  it("lifts error rows tagged error_type=external to external_error", () => {
    expect(normalizeStatus("error", "workflow", "external")).toBe(
      "external_error"
    );
  });

  it("keeps user/system/null error rows as plain error", () => {
    expect(normalizeStatus("error", "workflow", "user")).toBe("error");
    expect(normalizeStatus("error", "workflow", "system")).toBe("error");
    expect(normalizeStatus("error", "workflow", null)).toBe("error");
  });
});

describe("workflowDbStatuses", () => {
  it("expands the pending filter to also match phantom rows", () => {
    expect(workflowDbStatuses("pending")).toEqual(["pending", "phantom"]);
  });

  it("keeps error and system_error as distinct single-value filters", () => {
    expect(workflowDbStatuses("error")).toEqual(["error"]);
    expect(workflowDbStatuses("system_error")).toEqual(["system_error"]);
  });

  it("maps external_error onto the error DB status (split out by error_type)", () => {
    expect(workflowDbStatuses("external_error")).toEqual(["error"]);
  });

  it("expands the running filter to also match unconfirmed rows", () => {
    // A run whose broadcast hashes the chain has not confirmed is in flight,
    // so the running filter has to show it or it disappears from the UI.
    expect(workflowDbStatuses("running")).toEqual(["running", "unconfirmed"]);
  });

  it("leaves other statuses as a single-value filter", () => {
    expect(workflowDbStatuses("success")).toEqual(["success"]);
    expect(workflowDbStatuses("cancelled")).toEqual(["cancelled"]);
  });
});
