import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The org plan-gate (enforceWorkflowFeatures -> 402 upgrade_required) must run
// BEFORE action-config validation (validateWorkflowActionConfigs -> 422
// INVALID_ACTION_CONFIG) in every workflow-save route, so a plan-gated action
// whose config is also incomplete reports "upgrade required" instead of a
// generic config error. workflow-create-route.test.ts proves the runtime
// behavior for `create`; this guards the same ordering across all four routes,
// catching a re-inversion in any single one that a per-route behavioral test
// would miss.
const SAVE_ROUTES = [
  "app/api/workflows/create/route.ts",
  "app/api/workflows/current/route.ts",
  "app/api/workflows/import/route.ts",
  "app/api/workflows/[workflowId]/route.ts",
];

describe("workflow-save plan-gate ordering", () => {
  it.each(SAVE_ROUTES)(
    "%s runs the plan-gate before action-config validation",
    (route) => {
      const src = readFileSync(path.resolve(process.cwd(), route), "utf8");
      // Match the call sites (trailing "("), not the top-of-file imports.
      const gate = src.indexOf("enforceWorkflowFeatures(");
      const config = src.indexOf("validateWorkflowActionConfigs(");

      expect(
        gate,
        `${route}: enforceWorkflowFeatures( call not found`
      ).toBeGreaterThan(-1);
      expect(
        config,
        `${route}: validateWorkflowActionConfigs( call not found`
      ).toBeGreaterThan(-1);
      expect(
        gate,
        `${route}: plan-gate must precede action-config validation`
      ).toBeLessThan(config);
    }
  );
});
