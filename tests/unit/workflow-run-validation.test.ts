import { describe, expect, it, vi } from "vitest";
import {
  mapWorkflowValidationIssues,
  runWorkflowValidationPreflight,
  type WorkflowValidationIssue,
  type WorkflowValidationOverlayIssues,
} from "@/lib/workflow/editor/run-validation";

const nodes = [{ id: "trigger-1" }, { id: "action-1" }];

function createJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function createInvalidJsonResponse(): Response {
  return {
    ok: true,
    json: vi.fn().mockRejectedValue(new SyntaxError("Invalid JSON")),
  } as unknown as Response;
}

describe("mapWorkflowValidationIssues", () => {
  it("maps a node config path to its editor node and field", () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: "invalid-token-address",
        message: "Invalid contract address",
        parameterPath: "nodes[1].config.contractAddress",
      },
    ];

    expect(mapWorkflowValidationIssues(issues, nodes)).toEqual([
      {
        ...issues[0],
        nodeId: "action-1",
        fieldKey: "contractAddress",
      },
    ]);
  });

  it("maps nested config paths to the top-level editor field", () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: "invalid-token-address",
        message: "Invalid custom token address",
        parameterPath: "nodes[1].config.tokenConfig.customToken.address",
      },
    ];

    expect(mapWorkflowValidationIssues(issues, nodes)[0]).toMatchObject({
      nodeId: "action-1",
      fieldKey: "tokenConfig",
    });
  });

  it("leaves workflow-level issues without navigation targets", () => {
    const issue: WorkflowValidationIssue = {
      code: "empty-nodes-array",
      message: "Workflow has no nodes",
      parameterPath: "nodes",
    };

    expect(mapWorkflowValidationIssues([issue], nodes)).toEqual([issue]);
  });

  it("returns an empty array when the API omits the issues key", () => {
    expect(mapWorkflowValidationIssues(undefined, nodes)).toEqual([]);
  });
});

describe("runWorkflowValidationPreflight", () => {
  it("blocks execution and removes Run Anyway when errors are returned", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      createJsonResponse({
        result: {
          valid: false,
          nodeCount: 2,
          errors: [
            {
              code: "invalid-address",
              message: '"0x1234" is not a valid EVM address',
              parameterPath: "nodes[1].config.contractAddress",
            },
          ],
        },
      })
    );

    const onOpenIssues = vi.fn();
    const onStartWorkflowExecution = vi.fn();
    const onError = vi.fn();

    await runWorkflowValidationPreflight({
      workflowId: "workflow-1",
      nodes,
      fetcher,
      onOpenIssues,
      onStartWorkflowExecution,
      onError,
    });

    expect(fetcher).toHaveBeenCalledWith("/api/workflows/workflow-1/validate");

    expect(onOpenIssues).toHaveBeenCalledWith({
      validationErrors: [
        expect.objectContaining({
          code: "invalid-address",
          nodeId: "action-1",
          fieldKey: "contractAddress",
        }),
      ],
      validationWarnings: [],
      onRunAnyway: undefined,
    });

    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("offers Run Anyway when only warnings are returned", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      createJsonResponse({
        result: {
          valid: true,
          nodeCount: 2,
          warnings: [
            {
              code: "allowance-warning",
              message: "Allowance may be insufficient",
              parameterPath: "nodes[1].config.amount",
            },
          ],
        },
      })
    );

    const onOpenIssues = vi.fn();
    const onStartWorkflowExecution = vi.fn();
    const onError = vi.fn();

    await runWorkflowValidationPreflight({
      workflowId: "workflow-1",
      nodes,
      fetcher,
      onOpenIssues,
      onStartWorkflowExecution,
      onError,
    });

    expect(onOpenIssues).toHaveBeenCalledTimes(1);
    expect(onStartWorkflowExecution).not.toHaveBeenCalled();

    const overlayIssues = onOpenIssues.mock
      .calls[0]?.[0] as WorkflowValidationOverlayIssues;

    expect(overlayIssues.validationErrors).toEqual([]);
    expect(overlayIssues.validationWarnings).toEqual([
      expect.objectContaining({
        code: "allowance-warning",
        nodeId: "action-1",
        fieldKey: "amount",
      }),
    ]);
    expect(overlayIssues.onRunAnyway).toEqual(expect.any(Function));

    await overlayIssues.onRunAnyway?.();

    expect(onStartWorkflowExecution).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("starts execution immediately when validation is clean", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      createJsonResponse({
        result: {
          valid: true,
          nodeCount: 2,
        },
      })
    );

    const onOpenIssues = vi.fn();
    const onStartWorkflowExecution = vi.fn();
    const onError = vi.fn();

    await runWorkflowValidationPreflight({
      workflowId: "workflow-1",
      nodes,
      fetcher,
      onOpenIssues,
      onStartWorkflowExecution,
      onError,
    });

    expect(onOpenIssues).not.toHaveBeenCalled();
    expect(onStartWorkflowExecution).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports an unexpected response when the body is not JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue(createInvalidJsonResponse());
    const onOpenIssues = vi.fn();
    const onStartWorkflowExecution = vi.fn();
    const onError = vi.fn();

    await runWorkflowValidationPreflight({
      workflowId: "workflow-1",
      nodes,
      fetcher,
      onOpenIssues,
      onStartWorkflowExecution,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(
      "Workflow validation returned an unexpected response"
    );
    expect(onOpenIssues).not.toHaveBeenCalled();
    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
  });

  it("reports a validation failure when the endpoint is not successful", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(createJsonResponse({ error: "Failed" }, false));

    const onOpenIssues = vi.fn();
    const onStartWorkflowExecution = vi.fn();
    const onError = vi.fn();

    await runWorkflowValidationPreflight({
      workflowId: "workflow-1",
      nodes,
      fetcher,
      onOpenIssues,
      onStartWorkflowExecution,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(
      "Could not validate the workflow before running it"
    );
    expect(onOpenIssues).not.toHaveBeenCalled();
    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
  });
});
