import { describe, expect, it } from "vitest";
import { buildExecutorInput } from "@/lib/workflow/executor/build-executor-input";

// Every dispatch entry point (scheduled K8s job, in-process, MCP) builds its
// executor input through buildExecutorInput, so pinning the derivation here
// guards all of them. `organizationId` is the credential authority (steps
// authorize as the ORG principal - the org owns the workflow); `ownerId` is
// createdBy attribution for execution records and confers no credential
// access. A regression that drops organizationId would make org-visibility
// integrations fail closed as "DATABASE_URL is not configured".

const WORKFLOW = {
  id: "wf-1",
  userId: "owner-1",
  organizationId: "org-1",
  nodes: [{ id: "n1" }],
  edges: [{ id: "e1" }],
};

describe("buildExecutorInput", () => {
  it("derives createdBy and organizationId from the workflow", () => {
    const input = buildExecutorInput(WORKFLOW, {
      triggerInput: { foo: "bar" },
      executionId: "exec-1",
    });

    expect(input.createdBy).toBe("owner-1");
    expect(input.organizationId).toBe("org-1");
    expect(input.workflowId).toBe("wf-1");
  });

  it("maps a null organizationId to undefined and still sets createdBy", () => {
    const input = buildExecutorInput(
      { ...WORKFLOW, organizationId: null },
      { executionId: "exec-2" }
    );

    expect(input.organizationId).toBeUndefined();
    expect(input.createdBy).toBe("owner-1");
  });

  it("passes through the optional org metadata it is given", () => {
    const input = buildExecutorInput(WORKFLOW, {
      executionId: "exec-3",
      organizationName: "Acme",
      organizationSlug: "acme",
      organizationPlan: "pro",
    });

    expect(input.organizationName).toBe("Acme");
    expect(input.organizationSlug).toBe("acme");
    expect(input.organizationPlan).toBe("pro");
  });
});
