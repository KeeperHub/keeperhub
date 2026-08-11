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

const cleanValidationResponse = {
  result: {
    valid: true,
    nodeCount: 2,
  },
};

const cleanSimulationResponse = {
  result: {
    simulatedNodeCount: 0,
    skippedNodeCount: 0,
  },
};

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

  it("maps simulation data.config paths to editor fields", () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: "SIMULATION_WOULD_REVERT",
        message: "Transfer would revert",
        parameterPath: "nodes[1].data.config.recipientAddress",
      },
    ];

    expect(mapWorkflowValidationIssues(issues, nodes)[0]).toMatchObject({
      nodeId: "action-1",
      fieldKey: "recipientAddress",
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
  it("blocks on validation errors without calling simulation", async () => {
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

    expect(fetcher).toHaveBeenCalledTimes(1);
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
      onRunAnyway: onStartWorkflowExecution,
    });

    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("merges validation and simulation warnings and offers Run Anyway", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          result: {
            simulatedNodeCount: 0,
            skippedNodeCount: 1,
            warnings: [
              {
                code: "SIMULATION_DYNAMIC_INPUT",
                message: "Amount depends on an upstream step",
                parameterPath: "nodes[1].data.config.amount",
                nodeId: "action-1",
                fieldKey: "amount",
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

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/workflows/workflow-1/validate"
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/workflows/workflow-1/simulate",
      { method: "POST" }
    );

    const overlayIssues = onOpenIssues.mock
      .calls[0]?.[0] as WorkflowValidationOverlayIssues;

    expect(overlayIssues.validationErrors).toEqual([]);
    expect(overlayIssues.validationWarnings).toHaveLength(2);
    expect(overlayIssues.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "allowance-warning",
          nodeId: "action-1",
          fieldKey: "amount",
        }),
        expect.objectContaining({
          code: "SIMULATION_DYNAMIC_INPUT",
          nodeId: "action-1",
          fieldKey: "amount",
        }),
      ])
    );
    expect(overlayIssues.onRunAnyway).toEqual(expect.any(Function));

    await overlayIssues.onRunAnyway?.();

    expect(onStartWorkflowExecution).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("offers Run Anyway when simulation reports a revert", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(cleanValidationResponse))
      .mockResolvedValueOnce(
        createJsonResponse({
          result: {
            simulatedNodeCount: 0,
            skippedNodeCount: 0,
            warnings: [
              {
                code: "SIMULATION_WOULD_REVERT",
                message: "Transfer would revert: InsufficientBalance()",
                parameterPath: "nodes[1].data.config.recipientAddress",
                nodeId: "action-1",
                fieldKey: "recipientAddress",
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

    expect(onOpenIssues).toHaveBeenCalledWith({
      validationErrors: [],
      validationWarnings: [
        expect.objectContaining({
          code: "SIMULATION_WOULD_REVERT",
          nodeId: "action-1",
          fieldKey: "recipientAddress",
        }),
      ],
      onRunAnyway: onStartWorkflowExecution,
    });

    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("starts execution when validation and simulation are clean", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(cleanValidationResponse))
      .mockResolvedValueOnce(createJsonResponse(cleanSimulationResponse));

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

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onOpenIssues).not.toHaveBeenCalled();
    expect(onStartWorkflowExecution).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports an unexpected validation response when JSON is invalid", async () => {
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
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onOpenIssues).not.toHaveBeenCalled();
    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
  });

  it("reports an error when the validation endpoint fails", async () => {
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
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onOpenIssues).not.toHaveBeenCalled();
    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
  });

  it("offers Run Anyway when the simulation endpoint fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(cleanValidationResponse))
      .mockResolvedValueOnce(createJsonResponse({ error: "Failed" }, false));

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

    const overlayIssues = onOpenIssues.mock
      .calls[0]?.[0] as WorkflowValidationOverlayIssues;

    expect(overlayIssues.validationErrors).toEqual([]);
    expect(overlayIssues.validationWarnings).toEqual([
      expect.objectContaining({
        code: "SIMULATION_UNAVAILABLE",
        parameterPath: "nodes",
      }),
    ]);
    expect(overlayIssues.onRunAnyway).toEqual(expect.any(Function));

    await overlayIssues.onRunAnyway?.();

    expect(onStartWorkflowExecution).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("offers Run Anyway when the simulation response is invalid JSON", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(cleanValidationResponse))
      .mockResolvedValueOnce(createInvalidJsonResponse());

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

    expect(onOpenIssues).toHaveBeenCalledWith({
      validationErrors: [],
      validationWarnings: [
        expect.objectContaining({
          code: "SIMULATION_UNAVAILABLE",
          message: expect.stringContaining("unexpected response"),
        }),
      ],
      onRunAnyway: onStartWorkflowExecution,
    });
    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("offers Run Anyway when the simulation request throws", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(cleanValidationResponse))
      .mockRejectedValueOnce(new Error("network down"));

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

    expect(onOpenIssues).toHaveBeenCalledWith({
      validationErrors: [],
      validationWarnings: [
        expect.objectContaining({ code: "SIMULATION_UNAVAILABLE" }),
      ],
      onRunAnyway: onStartWorkflowExecution,
    });
    expect(onStartWorkflowExecution).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
