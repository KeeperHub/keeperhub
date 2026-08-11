import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { safeFetch } from "@/lib/safe-fetch";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { LinearCredentials } from "../credentials";

const LINEAR_API_URL = "https://api.linear.app/graphql";

type LinearGraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type IssuesQueryResponse = {
  issues: {
    nodes: Array<{
      id: string;
      title: string;
      url: string;
      priority: number;
      assignee?: {
        id: string;
      };
      state: {
        name: string;
      } | null;
    }>;
  };
};

type LinearIssue = {
  id: string;
  title: string;
  url: string;
  state: string;
  priority: number;
  assigneeId?: string;
};

type FindIssuesResult =
  | { success: true; data: { issues: LinearIssue[]; count: number } }
  | {
      success: false;
      error: { message: string };
      errorClass?: ExecutionErrorType;
    };

export type FindIssuesCoreInput = {
  linearAssigneeId?: string;
  linearTeamId?: string;
  linearStatus?: string;
  linearLabel?: string;
};

export type FindIssuesInput = StepInput &
  FindIssuesCoreInput & {
    integrationId?: string;
  };

async function linearQuery<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<LinearGraphQLResponse<T>> {
  const response = await safeFetch(LINEAR_API_URL, {
    plugin: "linear",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API error: HTTP ${response.status}`);
  }

  return response.json() as Promise<LinearGraphQLResponse<T>>;
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: FindIssuesCoreInput,
  credentials: LinearCredentials
): Promise<FindIssuesResult> {
  const apiKey = credentials.LINEAR_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: {
        message:
          "LINEAR_API_KEY is not configured. Please add it in Project Integrations.",
      },
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    // Build filter object for Linear's GraphQL API
    const filter: Record<string, unknown> = {};

    if (input.linearAssigneeId) {
      filter.assignee = { id: { eq: input.linearAssigneeId } };
    }

    if (input.linearTeamId) {
      filter.team = { id: { eq: input.linearTeamId } };
    }

    if (input.linearStatus && input.linearStatus !== "any") {
      filter.state = { name: { eqIgnoreCase: input.linearStatus } };
    }

    if (input.linearLabel) {
      filter.labels = { name: { eqIgnoreCase: input.linearLabel } };
    }

    const result = await linearQuery<IssuesQueryResponse>(
      apiKey,
      `query FindIssues($filter: IssueFilter) {
        issues(filter: $filter) {
          nodes {
            id
            title
            url
            priority
            assignee {
              id
            }
            state {
              name
            }
          }
        }
      }`,
      { filter: Object.keys(filter).length > 0 ? filter : undefined }
    );

    if (result.errors?.length) {
      return {
        success: false,
        error: { message: result.errors[0].message },
        errorClass: ExecutionErrorType.USER,
      };
    }

    const mappedIssues: LinearIssue[] = (result.data?.issues.nodes || []).map(
      (issue) => ({
        id: issue.id,
        title: issue.title,
        url: issue.url,
        state: issue.state?.name || "Unknown",
        priority: issue.priority,
        assigneeId: issue.assignee?.id || undefined,
      })
    );

    return {
      success: true,
      data: {
        issues: mappedIssues,
        count: mappedIssues.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: { message: `Failed to find issues: ${getErrorMessage(error)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function findIssuesStep(
  input: FindIssuesInput
): Promise<FindIssuesResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
findIssuesStep.maxRetries = 0;

export const _integrationType = "linear";
