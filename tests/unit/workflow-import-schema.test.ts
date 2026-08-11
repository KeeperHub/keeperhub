import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowExportV1Schema } from "@/lib/workflow/export-schema";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const HTTPS_MESSAGE_REGEX = /https:\/\//;

// Used by plan 42-09 to load fixtures inside each test body.
function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")
  ) as unknown;
}

describe("workflowExportV1Schema (SEC-03, SEC-04, SEC-06)", () => {
  it("accepts a valid baseline export", () => {
    const result = workflowExportV1Schema.safeParse(
      loadFixture("workflow-import-valid")
    );

    expect(result.success).toBe(true);
  });

  it("rejects an export with extra keys at the node envelope (.passthrough sealed by .strict)", () => {
    const result = workflowExportV1Schema.safeParse(
      loadFixture("workflow-import-passthrough-extras")
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.code === "unrecognized_keys"
      );
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(["nodes", 0]);
      // Zod 4 reports unrecognized keys via the `keys` field on the issue.
      const keys = (issue as { keys?: string[] } | undefined)?.keys ?? [];
      expect(keys).toContain("secretKey");
    }
  });

  it("rejects an export with more than 200 nodes", () => {
    const result = workflowExportV1Schema.safeParse(
      loadFixture("workflow-import-201-nodes")
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "nodes" && i.path.length === 1
      );
      expect(issue).toBeDefined();
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects a webhook node with a non-https webhookUrl", () => {
    const result = workflowExportV1Schema.safeParse(
      loadFixture("workflow-import-non-https-webhook")
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("webhookUrl")
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(HTTPS_MESSAGE_REGEX);
    }
  });

  it("parses a code-step-with-content fixture (rejection happens at UX layer, not schema)", () => {
    const result = workflowExportV1Schema.safeParse(
      loadFixture("workflow-import-code-step-with-content")
    );

    // The schema accepts code steps; the UX gate in WorkflowIOOverlay
    // (plan 42-07) forces explicit user confirmation via findCodeStepsWithContent.
    expect(result.success).toBe(true);
  });

  it("rejects an export whose description exceeds the 2000 char cap", () => {
    const valid = loadFixture("workflow-import-valid") as {
      workflow: { name: string; description?: string };
    };
    const tampered = {
      ...valid,
      workflow: {
        ...valid.workflow,
        description: "A".repeat(2001),
      },
    };

    const result = workflowExportV1Schema.safeParse(tampered);

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          i.path[0] === "workflow" &&
          i.path[1] === "description" &&
          i.code === "too_big"
      );
      expect(issue).toBeDefined();
    }
  });
});
