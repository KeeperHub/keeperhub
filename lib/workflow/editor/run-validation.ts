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

export type WorkflowValidationNode = {
  id?: unknown;
};

export type WorkflowValidationOverlayIssues = {
  validationErrors: WorkflowValidationIssue[];
  validationWarnings: WorkflowValidationIssue[];
  onRunAnyway?: () => void | Promise<void>;
};

type WorkflowValidationFetcher = (url: string) => Promise<Response>;

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
 * Adds editor navigation targets to server validation issues when their
 * parameter paths identify a specific workflow node.
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

/**
 * Runs server validation and decides whether execution is blocked, can be
 * overridden, or should start immediately.
 */
export async function runWorkflowValidationPreflight({
  workflowId,
  nodes,
  fetcher = fetch,
  onOpenIssues,
  onStartWorkflowExecution,
  onError,
}: RunWorkflowValidationPreflightParams): Promise<void> {
  let response: Response;

  try {
    response = await fetcher(`/api/workflows/${workflowId}/validate`);
  } catch {
    onError("Could not validate the workflow before running it");
    return;
  }

  if (!response.ok) {
    onError("Could not validate the workflow before running it");
    return;
  }

  const payload = (await response.json().catch(() => null)) as {
    result?: WorkflowValidationResult;
  } | null;

  if (!payload?.result) {
    onError("Workflow validation returned an unexpected response");
    return;
  }

  const validationErrors = mapWorkflowValidationIssues(
    payload.result.errors,
    nodes
  );
  const validationWarnings = mapWorkflowValidationIssues(
    payload.result.warnings,
    nodes
  );

  if (validationErrors.length > 0 || validationWarnings.length > 0) {
    onOpenIssues({
      validationErrors,
      validationWarnings,
      onRunAnyway:
        validationErrors.length === 0 ? onStartWorkflowExecution : undefined,
    });
    return;
  }

  await onStartWorkflowExecution();
}
