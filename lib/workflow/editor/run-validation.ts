export type WorkflowValidationIssue = {
  code: string;
  message: string;
  parameterPath: string;
  nodeId?: string;
  fieldKey?: string;
};

export type WorkflowValidationResult = {
  valid: boolean;
  nodeCount: number;
  errors?: WorkflowValidationIssue[];
  warnings?: WorkflowValidationIssue[];
};

/**
 * Preflight simulation is advisory, so the route only ever returns warnings.
 */
export type WorkflowSimulationResult = {
  simulatedNodeCount: number;
  skippedNodeCount: number;
  warnings?: WorkflowValidationIssue[];
};

export type WorkflowValidationNode = {
  id?: unknown;
};

export type WorkflowValidationOverlayIssues = {
  validationErrors: WorkflowValidationIssue[];
  validationWarnings: WorkflowValidationIssue[];
  onRunAnyway?: () => void | Promise<void>;
};

type WorkflowValidationFetcher = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

type RunWorkflowValidationPreflightParams = {
  workflowId: string;
  nodes: WorkflowValidationNode[];
  fetcher?: WorkflowValidationFetcher;
  onOpenIssues: (issues: WorkflowValidationOverlayIssues) => void;
  onStartWorkflowExecution: () => void | Promise<void>;
  onError: (message: string) => void;
};

const NODE_PARAMETER_PATH =
  /^nodes\[(\d+)\](?:\.data)?(?:\.config(?:\.([^.[\]]+))?)?/;

/**
 * Adds editor navigation targets to server issues when their parameter paths
 * identify a specific workflow node.
 */
export function mapWorkflowValidationIssues(
  issues: WorkflowValidationIssue[] | undefined,
  nodes: WorkflowValidationNode[]
): WorkflowValidationIssue[] {
  if (!issues) {
    return [];
  }

  return issues.map((issue) => {
    const match = NODE_PARAMETER_PATH.exec(issue.parameterPath);
    if (!match) {
      return issue;
    }

    const nodeIndex = Number(match[1]);
    const node = nodes[nodeIndex];

    if (!node || typeof node.id !== "string") {
      return issue;
    }

    return {
      ...issue,
      nodeId: node.id,
      fieldKey: match[2],
    };
  });
}

async function fetchValidationResult(
  workflowId: string,
  fetcher: WorkflowValidationFetcher,
  onError: (message: string) => void
): Promise<WorkflowValidationResult | null> {
  let response: Response;

  try {
    response = await fetcher(`/api/workflows/${workflowId}/validate`);
  } catch {
    onError("Could not validate the workflow before running it");
    return null;
  }

  if (!response.ok) {
    onError("Could not validate the workflow before running it");
    return null;
  }

  const payload = (await response.json().catch(() => null)) as {
    result?: WorkflowValidationResult;
  } | null;

  if (!payload?.result) {
    onError("Workflow validation returned an unexpected response");
    return null;
  }

  return payload.result;
}

function unavailableSimulationResult(
  message: string
): WorkflowSimulationResult {
  return {
    simulatedNodeCount: 0,
    skippedNodeCount: 0,
    warnings: [
      {
        code: "SIMULATION_UNAVAILABLE",
        message,
        parameterPath: "nodes",
      },
    ],
  };
}

async function fetchSimulationResult(
  workflowId: string,
  fetcher: WorkflowValidationFetcher
): Promise<WorkflowSimulationResult> {
  let response: Response;

  try {
    response = await fetcher(`/api/workflows/${workflowId}/simulate`, {
      method: "POST",
    });
  } catch {
    return unavailableSimulationResult(
      "Workflow write simulation was unavailable. You can still run the workflow."
    );
  }

  if (!response.ok) {
    return unavailableSimulationResult(
      "Workflow write simulation could not be completed. You can still run the workflow."
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    result?: WorkflowSimulationResult;
  } | null;

  if (!payload?.result) {
    return unavailableSimulationResult(
      "Workflow write simulation returned an unexpected response. You can still run the workflow."
    );
  }

  return payload.result;
}

/**
 * Runs structural validation followed by read-only EVM write simulation.
 *
 * Validation and simulation findings are advisory in the editor. Every issue
 * can be overridden through Run Anyway, matching the existing run path.
 */
export async function runWorkflowValidationPreflight({
  workflowId,
  nodes,
  fetcher = fetch,
  onOpenIssues,
  onStartWorkflowExecution,
  onError,
}: RunWorkflowValidationPreflightParams): Promise<void> {
  const validation = await fetchValidationResult(workflowId, fetcher, onError);

  if (!validation) {
    return;
  }

  const validationErrors = mapWorkflowValidationIssues(
    validation.errors,
    nodes
  );
  const validationWarnings = mapWorkflowValidationIssues(
    validation.warnings,
    nodes
  );

  // Avoid RPC work when structural validation already identifies issues, but
  // keep the existing editor precedent: the user may still choose Run Anyway.
  if (validationErrors.length > 0) {
    onOpenIssues({
      validationErrors,
      validationWarnings,
      onRunAnyway: onStartWorkflowExecution,
    });
    return;
  }

  const simulation = await fetchSimulationResult(workflowId, fetcher);

  const simulationWarnings = mapWorkflowValidationIssues(
    simulation.warnings,
    nodes
  );

  const combinedWarnings = [...validationWarnings, ...simulationWarnings];

  if (combinedWarnings.length > 0) {
    onOpenIssues({
      validationErrors,
      validationWarnings: combinedWarnings,
      onRunAnyway: onStartWorkflowExecution,
    });
    return;
  }

  await onStartWorkflowExecution();
}
