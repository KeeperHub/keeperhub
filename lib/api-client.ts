/**
 * API Client for making type-safe API calls to the backend
 * Replaces server actions with API endpoints
 */

import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { Page } from "@/lib/pagination";
import type { HeldPaymentView } from "@/lib/tempo/held-payment-view";
import type { VoteDirection } from "@/lib/workflow/editor/votes";
import type { WorkflowExportV1 } from "@/lib/workflow/export-schema";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";
import type { IntegrationConfig, IntegrationType } from "./types/integration";

// Workflow data types
export type WorkflowVisibility = "private" | "unlisted" | "public";

export type WorkflowData = {
  id?: string;
  name?: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  visibility?: WorkflowVisibility;
  enabled?: boolean;
  projectId?: string | null;
  tagId?: string | null;
  isListed?: boolean;
  listedSlug?: string | null;
  inputSchema?: Record<string, unknown> | null;
  outputMapping?: Record<string, unknown> | null;
  priceUsdcPerCall?: string | null;
  shareExecutionStatus?: boolean;
};

export type PublicTag = {
  id: string;
  name: string;
  slug: string;
  workflowCount?: number;
  createdAt?: string;
};

export type SavedWorkflow = WorkflowData & {
  id: string;
  name: string;
  visibility: WorkflowVisibility;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  isOwner?: boolean;
  featured?: boolean;
  projectId?: string | null;
  tagId?: string | null;
  featuredOrder?: number;
  featuredProtocol?: string | null;
  featuredProtocolOrder?: number;
  publicTags?: PublicTag[];
  isListed?: boolean;
  listedSlug?: string | null;
  listedAt?: string | null;
  // KEEP-440: set when the workflow has been soft-deleted. The owner-facing
  // list keeps showing these rows with a deleted marker.
  deletedAt?: string | null;
  // Set by ops via admin API when a workflow is deactivated. Distinct from
  // `enabled` (user toggle) — the user cannot clear this themselves.
  deactivatedAt?: string | null;
  inputSchema?: Record<string, unknown> | null;
  outputMapping?: Record<string, unknown> | null;
  priceUsdcPerCall?: string | null;
  score?: number;
  userVote?: VoteDirection | null;
  canVote?: boolean;
  duplicateCount?: number;
  // Present when loaded via getById(id, { version }).
  isHistoricalVersion?: boolean;
  version?: number;
  versionCreatedAt?: string;
};

export type WorkflowVersionActor = {
  id: string;
  name?: string | null;
  email?: string | null;
};

export type WorkflowVersionSummary = {
  version: number;
  source: "create" | "update" | "listing";
  contentHash: string;
  previousVersion: number | null;
  // deep-diff change records vs the previous version (null for v1).
  change: unknown;
  createdAt: string;
  changedBy: WorkflowVersionActor | null;
};

export type WorkflowHistoryResponse = Page<WorkflowVersionSummary>;

export type VoteResponse = {
  userVote: VoteDirection | null;
  score: number;
};

// API error class
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

// Helper function to make API calls
async function apiCall<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Unknown error" }));
    throw new ApiError(response.status, error.error || "Request failed");
  }

  return response.json();
}

// AI API

type StreamMessage = {
  type: "operation" | "complete" | "error";
  operation?: {
    op:
      | "setName"
      | "setDescription"
      | "addNode"
      | "addEdge"
      | "removeNode"
      | "removeEdge"
      | "updateNode";
    name?: string;
    description?: string;
    node?: unknown;
    edge?: unknown;
    nodeId?: string;
    edgeId?: string;
    updates?: {
      position?: { x: number; y: number };
      data?: unknown;
    };
  };
  error?: string;
};

type StreamState = {
  buffer: string;
  currentData: WorkflowData;
};

type OperationHandler = (
  op: StreamMessage["operation"],
  state: StreamState
) => void;

function handleSetName(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.name) {
    state.currentData.name = op.name;
  }
}

function handleSetDescription(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.description) {
    state.currentData.description = op.description;
  }
}

function handleAddNode(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.node) {
    state.currentData.nodes = [
      ...state.currentData.nodes,
      op.node as WorkflowNode,
    ];
  }
}

function handleAddEdge(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.edge) {
    state.currentData.edges = [
      ...state.currentData.edges,
      op.edge as WorkflowEdge,
    ];
  }
}

function handleRemoveNode(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.nodeId) {
    state.currentData.nodes = state.currentData.nodes.filter(
      (n) => n.id !== op.nodeId
    );
    state.currentData.edges = state.currentData.edges.filter(
      (e) => e.source !== op.nodeId && e.target !== op.nodeId
    );
  }
}

function handleRemoveEdge(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.edgeId) {
    state.currentData.edges = state.currentData.edges.filter(
      (e) => e.id !== op.edgeId
    );
  }
}

function handleUpdateNode(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.nodeId && op.updates) {
    state.currentData.nodes = state.currentData.nodes.map((n) => {
      if (n.id === op.nodeId) {
        return {
          ...n,
          ...(op.updates?.position ? { position: op.updates.position } : {}),
          ...(op.updates?.data
            ? { data: { ...n.data, ...op.updates.data } }
            : {}),
        };
      }
      return n;
    });
  }
}

const operationHandlers: Record<string, OperationHandler> = {
  setName: handleSetName,
  setDescription: handleSetDescription,
  addNode: handleAddNode,
  addEdge: handleAddEdge,
  removeNode: handleRemoveNode,
  removeEdge: handleRemoveEdge,
  updateNode: handleUpdateNode,
};

function applyOperation(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (!op?.op) {
    return;
  }

  const handler = operationHandlers[op.op];
  if (handler) {
    handler(op, state);
  }
}

function processStreamLine(
  line: string,
  onUpdate: (data: WorkflowData) => void,
  state: StreamState
): void {
  if (!line.trim()) {
    return;
  }

  try {
    const message = JSON.parse(line) as StreamMessage;

    if (message.type === "operation" && message.operation) {
      applyOperation(message.operation, state);
      onUpdate({ ...state.currentData });
    } else if (message.type === "error") {
      console.error("[API Client] Error:", message.error);
      throw new Error(message.error);
    }
  } catch (error) {
    console.error("[API Client] Failed to parse JSONL line:", error);
  }
}

function processStreamChunk(
  value: Uint8Array,
  decoder: TextDecoder,
  onUpdate: (data: WorkflowData) => void,
  state: StreamState
): void {
  state.buffer += decoder.decode(value, { stream: true });

  // Process complete JSONL lines
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";

  for (const line of lines) {
    processStreamLine(line, onUpdate, state);
  }
}

export const aiApi = {
  generate: (
    prompt: string,
    existingWorkflow?: {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      name?: string;
    }
  ) =>
    apiCall<WorkflowData>("/api/ai/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, existingWorkflow }),
    }),
  generateStream: async (
    prompt: string,
    onUpdate: (data: WorkflowData) => void,
    existingWorkflow?: {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      name?: string;
    }
  ): Promise<WorkflowData> => {
    const response = await fetch("/api/ai/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, existingWorkflow }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: StreamState = {
      buffer: "",
      currentData: existingWorkflow
        ? {
            nodes: existingWorkflow.nodes || [],
            edges: existingWorkflow.edges || [],
            name: existingWorkflow.name,
          }
        : { nodes: [], edges: [] },
    };

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        processStreamChunk(value, decoder, onUpdate, state);
      }

      return state.currentData;
    } finally {
      reader.releaseLock();
    }
  },
};

export type Integration = {
  id: string;
  name: string;
  type: IntegrationType;
  // Canonical EIP-55 wallet address for web3 integrations, null otherwise.
  address?: string | null;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
  // Creator identity, for the activity-history fallback.
  createdByName?: string | null;
  createdByEmail?: string | null;
  createdByRole?: string | null;
};

export type IntegrationWithConfig = Integration & {
  config: IntegrationConfig;
};

export type Organization = {
  id: string;
  name: string;
};

// Integration API
export const integrationApi = {
  // List all integrations
  getAll: (type?: IntegrationType) =>
    apiCall<Integration[]>(`/api/integrations${type ? `?type=${type}` : ""}`),

  // Get single integration with config
  get: (id: string) =>
    apiCall<IntegrationWithConfig>(`/api/integrations/${id}`),

  // Create integration
  create: (data: {
    name: string;
    type: IntegrationType;
    config: IntegrationConfig;
  }) =>
    apiCall<Integration>("/api/integrations", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Update integration
  update: (id: string, data: { name?: string; config?: IntegrationConfig }) =>
    apiCall<IntegrationWithConfig>(`/api/integrations/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Delete integration
  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/integrations/${id}`, {
      method: "DELETE",
    }),

  // Test existing integration connection, optionally with config overrides
  // that are merged server-side with stored secrets before testing
  testConnection: (
    integrationId: string,
    configOverrides?: IntegrationConfig
  ) =>
    apiCall<{ status: "success" | "error"; message: string }>(
      `/api/integrations/${integrationId}/test`,
      {
        method: "POST",
        ...(configOverrides
          ? { body: JSON.stringify({ configOverrides }) }
          : {}),
      }
    ),

  // Test credentials without saving
  testCredentials: (data: {
    type: IntegrationType;
    config: IntegrationConfig;
  }) =>
    apiCall<{ status: "success" | "error"; message: string }>(
      "/api/integrations/test",
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    ),
};

// Organization API
export const organizationApi = {
  updateName: (organizationId: string, data: { name: string }) =>
    apiCall<{ organization: Organization }>(
      `/api/organizations/${organizationId}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      }
    ),

  /** Leave organization. When sole owner, pass newOwnerMemberId for atomic transfer + leave. */
  leave: (organizationId: string, body: { newOwnerMemberId?: string }) =>
    apiCall<{ success: true }>(`/api/organizations/${organizationId}/leave`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** 2FA enrollment status per member, keyed by user id. Owner/admin only. */
  memberTwoFactorStatus: (organizationId: string) =>
    apiCall<{ statuses: Record<string, boolean> }>(
      `/api/organizations/${organizationId}/members/two-factor`
    ),
};

// Address Book API
export type AddressBookEntry = {
  id: string;
  label: string;
  address: string;
  createdAt: string;
  updatedAt: string;
  createdByName?: string | null;
};

export const addressBookApi = {
  getAll: () => apiCall<AddressBookEntry[]>("/api/address-book"),
  create: (data: { label: string; address: string }) =>
    apiCall<AddressBookEntry>("/api/address-book", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (entryId: string, data: { label?: string; address?: string }) =>
    apiCall<AddressBookEntry>(`/api/address-book/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (entryId: string) =>
    apiCall<{ success: boolean }>(`/api/address-book/${entryId}`, {
      method: "DELETE",
    }),
};

// Tempo Held Payments API
export const heldPaymentApi = {
  list: (params?: {
    page?: number;
    limit?: number;
    status?: string;
    q?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.page) {
      qs.set("page", String(params.page));
    }
    if (params?.limit) {
      qs.set("limit", String(params.limit));
    }
    if (params?.status) {
      qs.set("status", params.status);
    }
    if (params?.q?.trim()) {
      qs.set("q", params.q.trim());
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiCall<Page<HeldPaymentView>>(`/api/tempo/held-payments${suffix}`);
  },
  cancel: (id: string) =>
    apiCall<{ ok: boolean; status: string }>(
      `/api/tempo/held-payments/${id}/cancel`,
      { method: "POST" }
    ),
};

/** Broadcast returns the raw Response so the caller can branch on the step-up
 *  MFA codes (factors_required / mfa_code_invalid) carried in the JSON body. */
export function postHeldPaymentBroadcast(
  id: string,
  body: { code?: string; emailOtp?: string; signature?: string }
): Promise<Response> {
  return fetch(`/api/tempo/held-payments/${id}/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// User API
export const userApi = {
  get: () =>
    apiCall<{
      id: string;
      name: string | null;
      email: string;
      image: string | null;
      isAnonymous: boolean | null;
      providerId: string | null;
      walletAddress: string | null;
    }>("/api/user"),

  update: (data: {
    name?: string;
    email?: string;
    code?: string;
    emailOtp?: string;
  }) =>
    apiCall<{ success: boolean }>("/api/user", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};

// Workflow API
export const workflowApi = {
  // Get all workflows, optionally scoped server-side to a project or tag.
  getAll: (filter?: { projectId?: string; tagId?: string }) => {
    const qs = new URLSearchParams();
    if (filter?.projectId) {
      qs.set("projectId", filter.projectId);
    }
    if (filter?.tagId) {
      qs.set("tagId", filter.tagId);
    }
    const s = qs.toString();
    return apiCall<SavedWorkflow[]>(`/api/workflows${s ? `?${s}` : ""}`);
  },
  // Get public workflows (non-featured)
  getPublic: () => apiCall<SavedWorkflow[]>("/api/workflows/public"),
  // Get featured workflows
  getFeatured: () =>
    apiCall<SavedWorkflow[]>("/api/workflows/public?featured=true"),
  // Get protocol-featured workflows
  getProtocolFeatured: (slug: string) =>
    apiCall<SavedWorkflow[]>(
      `/api/workflows/public?featuredProtocol=${encodeURIComponent(slug)}`
    ),

  // Vote on a workflow (upvote/downvote toggle)
  voteWorkflow: (id: string, vote: VoteDirection) =>
    apiCall<VoteResponse>(`/api/workflows/${id}/rate`, {
      method: "POST",
      body: JSON.stringify({ vote }),
    }),

  // Get a specific workflow. Pass `version` to load a historical snapshot.
  getById: (id: string, options?: { version?: number }) =>
    apiCall<SavedWorkflow>(
      `/api/workflows/${id}${
        options?.version === undefined ? "" : `?version=${options.version}`
      }`
    ),

  // Version history timeline (admin/owner only).
  getHistory: (id: string, options?: { page?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.page !== undefined) {
      params.set("page", String(options.page));
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    const qs = params.toString();
    return apiCall<Page<WorkflowVersionSummary>>(
      `/api/workflows/${id}/history${qs ? `?${qs}` : ""}`
    );
  },

  // Create a new workflow
  create: (workflow: Omit<WorkflowData, "id">) =>
    apiCall<SavedWorkflow>("/api/workflows/create", {
      method: "POST",
      body: JSON.stringify(workflow),
    }),

  // Update a workflow
  update: (id: string, workflow: Partial<WorkflowData>) =>
    apiCall<SavedWorkflow>(`/api/workflows/${id}`, {
      method: "PATCH",
      body: JSON.stringify(workflow),
    }),

  // Delete a workflow
  delete: (id: string, options?: { force?: boolean }) =>
    apiCall<{ success: boolean }>(
      `/api/workflows/${id}${options?.force ? "?force=true" : ""}`,
      { method: "DELETE" }
    ),

  // Duplicate a workflow
  duplicate: (id: string) =>
    apiCall<SavedWorkflow>(`/api/workflows/${id}/duplicate`, {
      method: "POST",
    }),

  claim: (id: string) =>
    apiCall<SavedWorkflow>(`/api/workflows/${id}/claim`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  goLive: (
    id: string,
    data: {
      name: string;
      publicTagIds?: string[];
      mode?: "public" | "unlisted";
    }
  ) =>
    apiCall<SavedWorkflow>(`/api/workflows/${id}/go-live`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Get current workflow state
  getCurrent: () => apiCall<WorkflowData>("/api/workflows/current"),

  // Save current workflow state
  saveCurrent: (nodes: WorkflowNode[], edges: WorkflowEdge[]) =>
    apiCall<WorkflowData>("/api/workflows/current", {
      method: "POST",
      body: JSON.stringify({ nodes, edges }),
    }),

  // Execute workflow
  execute: (id: string, input: Record<string, unknown> = {}) =>
    apiCall<{
      executionId: string;
      status: string;
      output?: unknown;
      error?: string;
      duration?: number;
    }>(`/api/workflow/${id}/execute`, {
      method: "POST",
      body: JSON.stringify({ input }),
    }),

  // Trigger workflow via webhook
  triggerWebhook: (id: string, input: Record<string, unknown> = {}) =>
    apiCall<{
      executionId: string;
      status: string;
    }>(`/api/workflows/${id}/webhook`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Get workflow code
  getCode: (id: string) =>
    apiCall<{ code: string; workflowName: string }>(
      `/api/workflows/${id}/code`
    ),

  // Get executions
  getExecutions: (id: string) =>
    apiCall<
      Array<{
        id: string;
        workflowId: string;
        userId: string;
        status: string;
        input: unknown;
        output: unknown;
        error: string | null;
        errorType: ExecutionErrorType | null;
        errorCategory: string | null;
        errorCode: string | null;
        startedAt: Date;
        completedAt: Date | null;
        duration: string | null;
        // Progress tracking fields
        totalSteps: number | null;
        completedSteps: number | null;
        currentNodeId: string | null;
        currentNodeName: string | null;
        lastSuccessfulNodeId: string | null;
        lastSuccessfulNodeName: string | null;
        executionTrace: string[] | null;
        // The workflow_history version this run executed, resolved from the
        // run's content hash. Null when no matching version exists yet.
        ranVersion: number | null;
      }>
    >(`/api/workflows/${id}/executions`),

  // Delete executions
  deleteExecutions: (id: string) =>
    apiCall<{ success: boolean; deletedCount: number }>(
      `/api/workflows/${id}/executions`,
      {
        method: "DELETE",
      }
    ),

  // Get execution logs
  getExecutionLogs: (executionId: string) =>
    apiCall<{
      execution: {
        id: string;
        workflowId: string;
        userId: string;
        status: string;
        input: unknown;
        output: unknown;
        error: string | null;
        errorType: ExecutionErrorType | null;
        errorCategory: string | null;
        errorCode: string | null;
        startedAt: Date;
        completedAt: Date | null;
        duration: string | null;
        workflow: {
          id: string;
          name: string;
          nodes: unknown;
          edges: unknown;
        };
      };
      logs: Array<{
        id: string;
        executionId: string;
        nodeId: string;
        nodeName: string;
        nodeType: string;
        status: "pending" | "running" | "success" | "error" | "cancelled";
        input: unknown;
        output: unknown;
        error: string | null;
        startedAt: Date;
        completedAt: Date | null;
        duration: string | null;
        iterationIndex: number | null;
        forEachNodeId: string | null;
      }>;
    }>(`/api/workflows/executions/${executionId}/logs`),

  // Cancel a running execution
  cancelExecution: (executionId: string) =>
    apiCall<{ success: boolean }>(`/api/executions/${executionId}/cancel`, {
      method: "POST",
    }),

  // Get execution status
  getExecutionStatus: (executionId: string) =>
    apiCall<{
      status: string;
      nodeStatuses: Array<{
        nodeId: string;
        status: "pending" | "running" | "success" | "error" | "cancelled";
      }>;
      progress?: {
        totalSteps: number;
        completedSteps: number;
        runningSteps: number;
        currentNodeId: string | null;
        currentNodeName: string | null;
        percentage: number;
      };
      transactionHashes?: Array<{
        hash: string;
        nodeId: string;
        nodeName: string;
        chainId?: number;
        network?: string;
      }>;
    }>(`/api/workflows/executions/${executionId}/status`),

  // Export workflow as a versioned JSON document
  download: (id: string) =>
    apiCall<WorkflowExportV1>(`/api/workflows/${id}/download`),

  // Import a workflow from a v1 JSON export
  import: (payload: WorkflowExportV1) =>
    apiCall<SavedWorkflow & { integrationBindings?: unknown[] }>(
      "/api/workflows/import",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  // Auto-save with debouncing (kept for backwards compatibility)
  autoSaveCurrent: (() => {
    let autosaveTimeout: NodeJS.Timeout | null = null;
    const AUTOSAVE_DELAY = 2000;

    return (nodes: WorkflowNode[], edges: WorkflowEdge[]): void => {
      if (autosaveTimeout) {
        clearTimeout(autosaveTimeout);
      }

      autosaveTimeout = setTimeout(() => {
        workflowApi.saveCurrent(nodes, edges).catch((error) => {
          console.warn("Auto-save failed:", error);
        });
      }, AUTOSAVE_DELAY);
    };
  })(),

  // Auto-save specific workflow with debouncing
  autoSaveWorkflow: (() => {
    let autosaveTimeout: NodeJS.Timeout | null = null;
    const AUTOSAVE_DELAY = 2000;

    return (
      id: string,
      data: Partial<WorkflowData>,
      debounce = true
    ): Promise<SavedWorkflow> | undefined => {
      if (!debounce) {
        return workflowApi.update(id, data);
      }

      if (autosaveTimeout) {
        clearTimeout(autosaveTimeout);
      }

      autosaveTimeout = setTimeout(() => {
        workflowApi.update(id, data).catch((error) => {
          console.warn("Auto-save failed:", error);
        });
      }, AUTOSAVE_DELAY);
    };
  })(),
};

export type Tag = {
  id: string;
  name: string;
  color: string;
  workflowCount: number;
  organizationId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  createdByName?: string | null;
  createdByEmail?: string | null;
  createdByRole?: string | null;
};

export const tagApi = {
  getAll: () => apiCall<Tag[]>("/api/tags"),

  create: (data: { name: string; color: string }) =>
    apiCall<Tag>("/api/tags", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { name?: string; color?: string }) =>
    apiCall<Tag>(`/api/tags/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/tags/${id}`, {
      method: "DELETE",
    }),
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  workflowCount: number;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
  createdByName?: string | null;
  createdByEmail?: string | null;
  createdByRole?: string | null;
};

export const publicTagApi = {
  getAll: () => apiCall<PublicTag[]>("/api/public-tags"),

  create: (data: { name: string }) =>
    apiCall<PublicTag>("/api/public-tags", {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

export const projectApi = {
  getAll: () => apiCall<Project[]>("/api/projects"),

  create: (data: { name: string; description?: string; color?: string }) =>
    apiCall<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (
    id: string,
    data: { name?: string; description?: string; color?: string }
  ) =>
    apiCall<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/projects/${id}`, {
      method: "DELETE",
    }),
};

export type SecurityAuditEvent = {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  // Human label for the affected resource (currently workflows), resolved
  // server-side so the feed can name "which workflow" and link into it.
  resourceName: string | null;
  // The workflow history version this event produced, when one exists, so the
  // feed can deep-link to that exact version. Null for events with no version.
  version: number | null;
  createdAt: string;
  // biome-ignore lint/suspicious/noExplicitAny: stored deep-diff, shape varies by action
  diff: any;
  metadata: Record<string, unknown> | null;
  actor: {
    id: string;
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
};

export const securityApi = {
  // Org-scoped, admin/owner-gated audit trail. Filter by resource to get a
  // single resource's history (e.g. one API key's create/revoke events).
  getAudit: (params?: {
    resourceType?: string;
    resourceTypes?: string[];
    resourceId?: string;
    resourceIds?: string[];
    // Relational dimensions. The server expands a project/tag into the audit
    // events of the workflows under it; the client never assembles that set.
    projectIds?: string[];
    tagIds?: string[];
    workflowIds?: string[];
    action?: string;
    actorUserId?: string;
    actorUserIds?: string[];
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    // Single (per-resource views) and multi (filter builder) collapse to a
    // repeated query param the API reads with getAll().
    const resourceTypes =
      params?.resourceTypes ??
      (params?.resourceType ? [params.resourceType] : []);
    for (const t of resourceTypes) {
      qs.append("resourceType", t);
    }
    const resourceIds =
      params?.resourceIds ?? (params?.resourceId ? [params.resourceId] : []);
    for (const id of resourceIds) {
      qs.append("resourceId", id);
    }
    for (const id of params?.projectIds ?? []) {
      qs.append("projectId", id);
    }
    for (const id of params?.tagIds ?? []) {
      qs.append("tagId", id);
    }
    for (const id of params?.workflowIds ?? []) {
      qs.append("workflowId", id);
    }
    const actorUserIds =
      params?.actorUserIds ?? (params?.actorUserId ? [params.actorUserId] : []);
    for (const id of actorUserIds) {
      qs.append("actorUserId", id);
    }
    if (params?.action) {
      qs.set("action", params.action);
    }
    if (params?.from) {
      qs.set("from", params.from);
    }
    if (params?.to) {
      qs.set("to", params.to);
    }
    if (params?.search) {
      qs.set("q", params.search);
    }
    if (params?.page !== undefined) {
      qs.set("page", String(params.page));
    }
    if (params?.limit !== undefined) {
      qs.set("limit", String(params.limit));
    }
    const s = qs.toString();
    return apiCall<Page<SecurityAuditEvent>>(
      `/api/security/audit${s ? `?${s}` : ""}`
    );
  },
};

// Follow a HATEOAS pagination link (_links.next/prev/first/last) from any
// paginated endpoint, without reconstructing query params client-side.
export function followPage<T>(href: string): Promise<Page<T>> {
  return apiCall<Page<T>>(href);
}
// Export all APIs as a single object
export const api = {
  ai: aiApi,
  integration: integrationApi,
  organization: organizationApi,
  project: projectApi,
  publicTag: publicTagApi,
  security: securityApi,
  tag: tagApi,
  user: userApi,
  workflow: workflowApi,
};
