/**
 * Tests for workflow error context (ALS) and the high-cardinality label
 * strip in lib/logging.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

// Mock Sentry to avoid network/init noise.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// Capture metric calls so we can assert what reaches Prometheus.
const recordError = vi.fn();
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({ recordError }),
}));

import { ErrorCategory, logSystemError, logUserError } from "@/lib/logging";
import {
  enterWorkflowErrorContext,
  getWorkflowErrorContext,
  runWithWorkflowErrorContext,
  setWorkflowErrorContextStorage,
} from "@/lib/workflow-error-context";

beforeAll(() => {
  // Mirrors what instrumentation.ts does at server startup.
  setWorkflowErrorContextStorage(new AsyncLocalStorage());
});

describe("workflow error context", () => {
  beforeEach(() => {
    recordError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runWithWorkflowErrorContext exposes labels inside the callback", () => {
    runWithWorkflowErrorContext(
      { workflow_id: "wf-1", org_id: "org-1", org_slug: "acme" },
      () => {
        const ctx = getWorkflowErrorContext();
        expect(ctx).toEqual({
          workflow_id: "wf-1",
          org_id: "org-1",
          org_slug: "acme",
        });
      }
    );
  });

  it("nested runs merge inner over outer", () => {
    runWithWorkflowErrorContext({ org_id: "org-1", org_slug: "acme" }, () => {
      runWithWorkflowErrorContext({ workflow_id: "wf-2" }, () => {
        const ctx = getWorkflowErrorContext();
        expect(ctx).toEqual({
          org_id: "org-1",
          org_slug: "acme",
          workflow_id: "wf-2",
        });
      });
    });
  });
});

describe("logging.ts cardinality strip", () => {
  beforeEach(() => {
    recordError.mockClear();
    // Silence the console writes from logUserError/logSystemError.
    vi.spyOn(console, "warn").mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips execution_id, org_id and owner_id from metric labels", () => {
    runWithWorkflowErrorContext(
      {
        workflow_id: "wf-1",
        execution_id: "exec-1",
        org_id: "org-1",
        org_slug: "acme",
        owner_id: "user-1",
      },
      () => {
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[Test] something failed",
          new Error("boom")
        );
      }
    );

    expect(recordError).toHaveBeenCalledTimes(1);
    const labels = recordError.mock.calls[0][2] as Record<string, string>;
    expect(labels.workflow_id).toBe("wf-1");
    expect(labels.org_slug).toBe("acme");
    expect(labels.execution_id).toBeUndefined();
    expect(labels.org_id).toBeUndefined();
    expect(labels.owner_id).toBeUndefined();
  });

  it("merges ALS context with caller-provided labels (caller wins)", () => {
    runWithWorkflowErrorContext(
      { org_slug: "acme", workflow_id: "wf-1" },
      () => {
        logUserError(
          ErrorCategory.VALIDATION,
          "[Test] bad input",
          new Error("nope"),
          { org_slug: "override", custom_label: "x" }
        );
      }
    );

    const labels = recordError.mock.calls[0][2] as Record<string, string>;
    expect(labels.org_slug).toBe("override");
    expect(labels.workflow_id).toBe("wf-1");
    expect(labels.custom_label).toBe("x");
  });

  it("enterWorkflowErrorContext sets labels for the current async chain", async () => {
    await new Promise<void>((resolve) => {
      // Run inside a callback so the enterWith doesn't bleed into other tests.
      runWithWorkflowErrorContext({}, () => {
        enterWorkflowErrorContext({ workflow_id: "wf-9", org_slug: "globex" });
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[Test] late",
          new Error("late")
        );
        const labels = recordError.mock.calls[0][2] as Record<string, string>;
        expect(labels.workflow_id).toBe("wf-9");
        expect(labels.org_slug).toBe("globex");
        resolve();
      });
    });
  });
});
