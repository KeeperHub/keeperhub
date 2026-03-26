"use client";

import { useReactFlow } from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Check,
  Copy,
  Download,
  Loader2,
  Lock,
  Share2,
  Play,
  Plus,
  Redo2,
  Save,
  Settings2,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { nanoid } from "nanoid";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OrgSwitcher } from "@/components/organization/org-switcher";
import { GoLiveOverlay } from "@/components/overlays/go-live-overlay";
import { Switch } from "@/components/ui/switch";
import { BUILTIN_NODE_ID } from "@/lib/builtin-variables";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { api, ApiError, type Project, type Tag } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { getCustomLogo } from "@/lib/extension-registry";
import { integrationsAtom } from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
import { cn } from "@/lib/utils";
import {
  addNodeAtom,
  canRedoAtom,
  canUndoAtom,
  clearWorkflowAtom,
  currentExecutionIdAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  currentWorkflowPublicTagsAtom,
  currentWorkflowVisibilityAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  isExecutingAtom,
  isGeneratingAtom,
  isSavingAtom,
  isWorkflowEnabled,
  isWorkflowOwnerAtom,
  nodesAtom,
  propertiesPanelActiveTabAtom,
  redoAtom,
  runsRefreshTriggerAtom,
  selectedEdgeAtom,
  selectedExecutionIdAtom,
  selectedNodeAtom,
  triggerExecuteAtom,
  undoAtom,
  updateNodeDataAtom,
  type WorkflowEdge,
  type WorkflowNode,
  WorkflowTriggerEnum,
  type WorkflowVisibility,
} from "@/lib/workflow-store";
import {
  findActionById,
  flattenConfigFields,
  getIntegration,
  getIntegrationLabels,
} from "@/plugins/registry";
import { Panel } from "../ai-elements/panel";
import { ConfigurationOverlay } from "../overlays/configuration-overlay";
import { ConfirmOverlay } from "../overlays/confirm-overlay";
import { ExportWorkflowOverlay } from "../overlays/export-workflow-overlay";
import { useOverlay } from "../overlays/overlay-provider";
import { WorkflowIssuesOverlay } from "../overlays/workflow-issues-overlay";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { UserMenu } from "../workflows/user-menu";
type WorkflowToolbarProps = {
  workflowId?: string;
  persistent?: boolean;
};

// Helper functions to reduce complexity
function updateNodesStatus(
  nodes: WorkflowNode[],
  updateNodeData: (update: {
    id: string;
    data: { status?: "idle" | "running" | "success" | "error" };
  }) => void,
  status: "idle" | "running" | "success" | "error"
) {
  for (const node of nodes) {
    updateNodeData({ id: node.id, data: { status } });
  }
}

type MissingIntegrationInfo = {
  integrationType: IntegrationType;
  integrationLabel: string;
  nodeNames: string[];
};

// Built-in actions that require integrations but aren't in the plugin registry
const BUILTIN_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
  "Database Query": "database",
};

// Labels for built-in integration types that don't have plugins
const BUILTIN_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};

// Type for broken template reference info
type BrokenTemplateReferenceInfo = {
  nodeId: string;
  nodeLabel: string;
  brokenReferences: Array<{
    fieldKey: string;
    fieldLabel: string;
    referencedNodeId: string;
    displayText: string;
  }>;
};

// Extract template variables from a string and check if they reference existing nodes
function extractTemplateReferences(
  value: unknown
): Array<{ nodeId: string; displayText: string }> {
  if (typeof value !== "string") {
    return [];
  }

  const pattern = /\{\{@([^:]+):([^}]+)\}\}/g;
  const matches = value.matchAll(pattern);

  return Array.from(matches).map((match) => ({
    nodeId: match[1],
    displayText: match[2],
  }));
}

// Recursively extract all template references from a config object
function extractAllTemplateReferences(
  config: Record<string, unknown>,
  prefix = ""
): Array<{ field: string; nodeId: string; displayText: string }> {
  const results: Array<{ field: string; nodeId: string; displayText: string }> =
    [];

  for (const [key, value] of Object.entries(config)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      const refs = extractTemplateReferences(value);
      for (const ref of refs) {
        results.push({ field: fieldPath, ...ref });
      }
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      results.push(
        ...extractAllTemplateReferences(
          value as Record<string, unknown>,
          fieldPath
        )
      );
    }
  }

  return results;
}

// Get broken template references for workflow nodes
function getBrokenTemplateReferences(
  nodes: WorkflowNode[]
): BrokenTemplateReferenceInfo[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const brokenByNode: BrokenTemplateReferenceInfo[] = [];

  for (const node of nodes) {
    // Skip disabled nodes
    if (node.data.enabled === false) {
      continue;
    }

    const config = node.data.config as Record<string, unknown> | undefined;
    if (!config || typeof config !== "object") {
      continue;
    }

    const allRefs = extractAllTemplateReferences(config);
    const brokenRefs = allRefs.filter(
      (ref) => ref.nodeId !== BUILTIN_NODE_ID && !nodeIds.has(ref.nodeId)
    );

    if (brokenRefs.length > 0) {
      // Get action for label lookups
      const actionType = config.actionType as string | undefined;
      const action = actionType ? findActionById(actionType) : undefined;
      const flatFields = action ? flattenConfigFields(action.configFields) : [];

      brokenByNode.push({
        nodeId: node.id,
        nodeLabel: node.data.label || action?.label || "Unnamed Step",
        brokenReferences: brokenRefs.map((ref) => {
          // Look up human-readable field label
          const configField = flatFields.find((f) => f.key === ref.field);
          return {
            fieldKey: ref.field,
            fieldLabel: configField?.label || ref.field,
            referencedNodeId: ref.nodeId,
            displayText: ref.displayText,
          };
        }),
      });
    }
  }

  return brokenByNode;
}

// Type for missing required fields info
type MissingRequiredFieldInfo = {
  nodeId: string;
  nodeLabel: string;
  missingFields: Array<{
    fieldKey: string;
    fieldLabel: string;
  }>;
};

// Check if a field value is effectively empty
function isFieldEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string" && value.trim() === "") {
    return true;
  }
  return false;
}

// Check if a conditional field should be shown based on current config
function shouldShowField(
  field: {
    showWhen?:
      | { field: string; equals: string }
      | { field: string; oneOf: string[] };
  },
  config: Record<string, unknown>
): boolean {
  if (!field.showWhen) {
    return true;
  }
  const dependentValue = config[field.showWhen.field];
  if ("oneOf" in field.showWhen) {
    return field.showWhen.oneOf.includes(dependentValue as string);
  }
  return dependentValue === field.showWhen.equals;
}

// Get missing required fields for a single node
function getNodeMissingFields(
  node: WorkflowNode
): MissingRequiredFieldInfo | null {
  if (node.data.enabled === false) {
    return null;
  }

  const config = node.data.config as Record<string, unknown> | undefined;
  const actionType = config?.actionType as string | undefined;
  if (!actionType) {
    return null;
  }

  const action = findActionById(actionType);
  if (!action) {
    return null;
  }

  // Flatten grouped fields to check all required fields
  const flatFields = flattenConfigFields(action.configFields);

  const missingFields = flatFields
    .filter(
      (field) =>
        field.required &&
        shouldShowField(field, config || {}) &&
        isFieldEmpty(config?.[field.key])
    )
    .map((field) => ({
      fieldKey: field.key,
      fieldLabel: field.label,
    }));

  if (missingFields.length === 0) {
    return null;
  }

  return {
    nodeId: node.id,
    nodeLabel: node.data.label || action.label || "Unnamed Step",
    missingFields,
  };
}

// Get missing required fields for workflow nodes
function getMissingRequiredFields(
  nodes: WorkflowNode[]
): MissingRequiredFieldInfo[] {
  return nodes
    .map(getNodeMissingFields)
    .filter((result): result is MissingRequiredFieldInfo => result !== null);
}

// Get missing integrations for workflow nodes
// Uses the plugin registry to determine which integrations are required
// Also handles built-in actions that aren't in the plugin registry
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Upstream function - preserving original structure for easier merges
function getMissingIntegrations(
  nodes: WorkflowNode[],
  userIntegrations: Array<{ id: string; type: IntegrationType }>
): MissingIntegrationInfo[] {
  const userIntegrationTypes = new Set(userIntegrations.map((i) => i.type));
  const userIntegrationIds = new Set(userIntegrations.map((i) => i.id));
  const missingByType = new Map<IntegrationType, string[]>();
  const integrationLabels = getIntegrationLabels();

  for (const node of nodes) {
    // Skip disabled nodes
    if (node.data.enabled === false) {
      continue;
    }

    const actionType = node.data.config?.actionType as string | undefined;
    if (!actionType) {
      continue;
    }

    // Look up the integration type from the plugin registry first
    const action = findActionById(actionType);
    // Fall back to built-in action integrations for actions not in the registry
    const requiredIntegrationType =
      action?.integration || BUILTIN_ACTION_INTEGRATIONS[actionType];

    if (!requiredIntegrationType) {
      continue;
    }

    // Skip integrations that don't require credentials (e.g., webhook)
    const plugin = getIntegration(requiredIntegrationType);
    if (plugin && plugin.requiresCredentials === false) {
      continue;
    }

    // Check if this node has a valid integrationId configured
    // The integration must exist (not just be configured)
    const configuredIntegrationId = node.data.config?.integrationId as
      | string
      | undefined;
    const hasValidIntegration =
      configuredIntegrationId &&
      userIntegrationIds.has(configuredIntegrationId);
    if (hasValidIntegration) {
      continue;
    }

    // Check if user has any integration of this type
    if (!userIntegrationTypes.has(requiredIntegrationType)) {
      const existing = missingByType.get(requiredIntegrationType) || [];
      // Use human-readable label from registry if no custom label
      const actionInfo = findActionById(actionType);
      existing.push(node.data.label || actionInfo?.label || actionType);
      missingByType.set(requiredIntegrationType, existing);
    }
  }

  return Array.from(missingByType.entries()).map(
    ([integrationType, nodeNames]) => ({
      integrationType,
      integrationLabel:
        integrationLabels[integrationType] ||
        BUILTIN_INTEGRATION_LABELS[integrationType] ||
        integrationType,
      nodeNames,
    })
  );
}

type ExecuteTestWorkflowParams = {
  workflowId: string;
  nodes: WorkflowNode[];
  updateNodeData: (update: {
    id: string;
    data: { status?: "idle" | "running" | "success" | "error" };
  }) => void;
  pollingIntervalRef: React.MutableRefObject<NodeJS.Timeout | null>;
  setIsExecuting: (value: boolean) => void;
  setSelectedExecutionId: (value: string | null) => void;
  setCurrentExecutionId: (value: string | null) => void;
  onExecutionStarted?: () => void;
};

async function executeTestWorkflow({
  workflowId,
  nodes,
  updateNodeData,
  pollingIntervalRef,
  setIsExecuting,
  setSelectedExecutionId,
  setCurrentExecutionId,
  onExecutionStarted,
}: ExecuteTestWorkflowParams) {
  // Set all nodes to idle first
  updateNodesStatus(nodes, updateNodeData, "idle");

  // Immediately set trigger nodes to running for instant visual feedback
  for (const node of nodes) {
    if (node.data.type === "trigger") {
      updateNodeData({ id: node.id, data: { status: "running" } });
    }
  }

  try {
    // Start the execution via API
    const response = await fetch(`/api/workflow/${workflowId}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: {} }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message =
        typeof body?.error === "string"
          ? body.error
          : "Failed to execute workflow";
      throw new Error(message);
    }

    const result = await response.json();

    // Select the new execution and track its ID for cancel support
    setSelectedExecutionId(result.executionId);
    setCurrentExecutionId(result.executionId);

    // Signal the Runs panel to refresh immediately
    onExecutionStarted?.();

    // Poll for execution status updates
    const pollInterval = setInterval(async () => {
      // Skip if polling was cancelled (e.g. user clicked Stop)
      if (!pollingIntervalRef.current) {
        return;
      }

      try {
        const statusData = await api.workflow.getExecutionStatus(
          result.executionId
        );

        // Skip update if cancelled while fetch was in-flight
        if (!pollingIntervalRef.current) {
          return;
        }

        // Update node statuses based on the execution logs
        for (const nodeStatus of statusData.nodeStatuses) {
          updateNodeData({
            id: nodeStatus.nodeId,
            data: {
              status: nodeStatus.status as
                | "idle"
                | "running"
                | "success"
                | "error",
            },
          });
        }

        // Stop polling if execution is complete
        if (statusData.status !== "running") {
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }

          setIsExecuting(false);
          setCurrentExecutionId(null);

          // Reset nodes to idle when cancelled (steps may show stale "success" from runtime)
          if (statusData.status === "cancelled") {
            updateNodesStatus(nodes, updateNodeData, "idle");
          }
        }
      } catch (error) {
        console.error("Failed to poll execution status:", error);
      }
    }, 500); // Poll every 500ms

    pollingIntervalRef.current = pollInterval;
  } catch (error) {
    console.error("Failed to execute workflow:", error);
    toast.error(
      error instanceof Error ? error.message : "Failed to execute workflow"
    );
    updateNodesStatus(nodes, updateNodeData, "error");
    setIsExecuting(false);
    setCurrentExecutionId(null);
  }
}

// Hook for workflow handlers
type WorkflowHandlerParams = {
  currentWorkflowId: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updateNodeData: (update: {
    id: string;
    data: { status?: "idle" | "running" | "success" | "error" };
  }) => void;
  isExecuting: boolean;
  setIsExecuting: (value: boolean) => void;
  setIsSaving: (value: boolean) => void;
  setHasUnsavedChanges: (value: boolean) => void;
  setActiveTab: (value: string) => void;
  setNodes: (nodes: WorkflowNode[]) => void;
  setEdges: (edges: WorkflowEdge[]) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedExecutionId: (id: string | null) => void;
  currentExecutionId: string | null;
  setCurrentExecutionId: (id: string | null) => void;
  userIntegrations: Array<{ id: string; type: IntegrationType }>;
};

function useWorkflowHandlers({
  currentWorkflowId,
  nodes,
  edges,
  updateNodeData,
  isExecuting,
  setIsExecuting,
  setIsSaving,
  setHasUnsavedChanges,
  setActiveTab,
  setNodes,
  setEdges,
  setSelectedNodeId,
  setSelectedExecutionId,
  currentExecutionId,
  setCurrentExecutionId,
  userIntegrations,
}: WorkflowHandlerParams) {
  const { open: openOverlay } = useOverlay();
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const setRunsRefreshTrigger = useSetAtom(runsRefreshTriggerAtom);

  // Cleanup polling interval on unmount
  useEffect(
    () => () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    },
    []
  );

  const handleSave = async () => {
    if (!currentWorkflowId) {
      return;
    }

    setIsSaving(true);
    try {
      await api.workflow.update(currentWorkflowId, { nodes, edges });
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error("Failed to save workflow:", error);
      toast.error("Failed to save workflow. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const executeWorkflow = async () => {
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    // Switch to Runs tab when starting a test run
    setActiveTab("runs");

    // Deselect all nodes and edges
    setNodes(nodes.map((node) => ({ ...node, selected: false })));
    setEdges(edges.map((edge) => ({ ...edge, selected: false })));
    setSelectedNodeId(null);

    setIsExecuting(true);
    await executeTestWorkflow({
      workflowId: currentWorkflowId,
      nodes,
      updateNodeData,
      pollingIntervalRef,
      setIsExecuting,
      setSelectedExecutionId,
      setCurrentExecutionId,
      onExecutionStarted: () => setRunsRefreshTrigger((c) => c + 1),
    });
    // Don't set executing to false here - let polling handle it
  };

  const handleCancel = async (): Promise<void> => {
    // Best-effort cancel via API (may fail if execution already completed)
    if (currentExecutionId) {
      try {
        await api.workflow.cancelExecution(currentExecutionId);
      } catch {
        // Execution may have already completed
      }
    }

    // Stop polling
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    setIsExecuting(false);
    setCurrentExecutionId(null);

    // Reset all node statuses to idle
    updateNodesStatus(nodes, updateNodeData, "idle");

    toast.success("Workflow execution cancelled");
  };

  const handleGoToStep = (nodeId: string, fieldKey?: string) => {
    setSelectedNodeId(nodeId);
    setActiveTab("properties");

    // Focus on the specific field after a short delay to allow the panel to render
    if (fieldKey) {
      setTimeout(() => {
        const element = document.getElementById(fieldKey);
        if (element) {
          element.focus();
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
    }
  };

  /**
   * Get workflow validation issues (broken refs, missing fields, missing integrations).
   * Returns null if no issues found.
   */
  const getWorkflowIssues = () => {
    const brokenRefs = getBrokenTemplateReferences(nodes);
    const missingFields = getMissingRequiredFields(nodes);
    const missingIntegrations = getMissingIntegrations(nodes, userIntegrations);

    if (
      brokenRefs.length > 0 ||
      missingFields.length > 0 ||
      missingIntegrations.length > 0
    ) {
      return {
        brokenReferences: brokenRefs,
        missingRequiredFields: missingFields,
        missingIntegrations,
      };
    }
    return null;
  };

  /**
   * Validate workflow and show issues overlay if problems found.
   * @param onProceed - Callback to run if user clicks proceed (or validation passes)
   * @param actionLabel - Label for the proceed button (default: "Run Anyway")
   * @returns true if validation passed, false if issues overlay was shown
   */
  const validateAndProceed = (
    onProceed: () => void | Promise<void>,
    actionLabel?: string
  ): boolean => {
    const issues = getWorkflowIssues();

    if (issues) {
      openOverlay(WorkflowIssuesOverlay, {
        issues,
        onGoToStep: handleGoToStep,
        onRunAnyway: onProceed,
        actionLabel,
      });
      return false;
    }

    return true;
  };

  const handleExecute = async () => {
    // Guard against concurrent executions
    if (isExecuting) {
      return;
    }

    if (validateAndProceed(executeWorkflow)) {
      await executeWorkflow();
    }
  };

  return {
    handleSave,
    handleExecute,
    handleCancel,
    validateAndProceed,
    handleGoToStep,
  };
}

// Hook for workflow state management
function useWorkflowState() {
  const [nodes, setNodes] = useAtom(nodesAtom);
  const [edges, setEdges] = useAtom(edgesAtom);
  const [isExecuting, setIsExecuting] = useAtom(isExecutingAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [workflowName, setCurrentWorkflowName] = useAtom(
    currentWorkflowNameAtom
  );
  const [workflowVisibility, setWorkflowVisibility] = useAtom(
    currentWorkflowVisibilityAtom
  );
  const [workflowPublicTags, setWorkflowPublicTags] = useAtom(
    currentWorkflowPublicTagsAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const router = useRouter();
  const [isSaving, setIsSaving] = useAtom(isSavingAtom);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useAtom(
    hasUnsavedChangesAtom
  );
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const addNode = useSetAtom(addNodeAtom);
  const [canUndo] = useAtom(canUndoAtom);
  const [canRedo] = useAtom(canRedoAtom);
  const { data: session } = useSession();
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeAtom);
  const setSelectedExecutionId = useSetAtom(selectedExecutionIdAtom);
  const userIntegrations = useAtomValue(integrationsAtom);
  const [triggerExecute, setTriggerExecute] = useAtom(triggerExecuteAtom);
  const [currentExecutionId, setCurrentExecutionId] = useAtom(
    currentExecutionIdAtom
  );

  const [isDownloading, setIsDownloading] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [allWorkflows, setAllWorkflows] = useState<
    Array<{
      id: string;
      name: string;
      updatedAt: string;
      projectId?: string | null;
      tagId?: string | null;
    }>
  >([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [isEnabled, setIsEnabled] = useAtom(isWorkflowEnabled);

  // Load all workflows and projects on mount
  useEffect(() => {
    const loadAllWorkflows = async () => {
      try {
        const [workflows, projects, tags] = await Promise.all([
          api.workflow.getAll(),
          api.project.getAll().catch(() => [] as Project[]),
          api.tag.getAll().catch(() => [] as Tag[]),
        ]);
        setAllWorkflows(workflows);
        setAllProjects(projects);
        setAllTags(tags);
      } catch (error) {
        console.error("Failed to load workflows:", error);
      }
    };
    loadAllWorkflows();
  }, []);

  return {
    nodes,
    edges,
    isExecuting,
    setIsExecuting,
    isGenerating,
    clearWorkflow,
    updateNodeData,
    currentWorkflowId,
    workflowName,
    setCurrentWorkflowName,
    workflowVisibility,
    setWorkflowVisibility,
    workflowPublicTags, // keeperhub custom field //
    setWorkflowPublicTags, // keeperhub custom field //
    isOwner,
    router,
    isSaving,
    setIsSaving,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    undo,
    redo,
    addNode,
    canUndo,
    canRedo,
    session,
    isDownloading,
    setIsDownloading,
    isDuplicating,
    setIsDuplicating,
    allWorkflows,
    setAllWorkflows,
    allProjects, // keeperhub custom field //
    setAllProjects, // keeperhub custom field //
    allTags, // keeperhub custom field //
    setAllTags, // keeperhub custom field //
    setActiveTab,
    setNodes,
    setEdges,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
    triggerExecute,
    setTriggerExecute,
    currentExecutionId,
    setCurrentExecutionId,
    isEnabled,
    setIsEnabled,
  };
}

// Hook for workflow actions
function useWorkflowActions(state: ReturnType<typeof useWorkflowState>) {
  const { open: openOverlay } = useOverlay();
  const {
    currentWorkflowId,
    workflowName,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    setIsSaving,
    setHasUnsavedChanges,
    clearWorkflow,
    setWorkflowVisibility,
    workflowPublicTags, // keeperhub custom field //
    setWorkflowPublicTags, // keeperhub custom field //
    setAllWorkflows,
    allTags, // keeperhub custom field //
    setAllProjects, // keeperhub custom field //
    setAllTags, // keeperhub custom field //
    setIsDownloading,
    setIsDuplicating,
    setActiveTab,
    setNodes,
    setEdges,
    setSelectedNodeId,
    setSelectedExecutionId,
    currentExecutionId,
    setCurrentExecutionId,
    userIntegrations,
    triggerExecute,
    setTriggerExecute,
    router,
    session,
  } = state;

  const { handleSave, handleExecute, handleCancel, validateAndProceed } =
    useWorkflowHandlers({
      currentWorkflowId,
      nodes,
      edges,
      updateNodeData,
      isExecuting,
      setIsExecuting,
      setIsSaving,
      setHasUnsavedChanges,
      setActiveTab,
      setNodes,
      setEdges,
      setSelectedNodeId,
      setSelectedExecutionId,
      currentExecutionId,
      setCurrentExecutionId,
      userIntegrations,
    });

  // Listen for execute trigger from keyboard shortcut
  useEffect(() => {
    if (triggerExecute) {
      setTriggerExecute(false);
      handleExecute();
    }
  }, [triggerExecute, setTriggerExecute, handleExecute]);

  const handleClearWorkflow = () => {
    openOverlay(ConfirmOverlay, {
      title: "Clear Workflow",
      message:
        "Are you sure you want to clear all nodes and connections? This action cannot be undone.",
      confirmLabel: "Clear Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        clearWorkflow();
      },
    });
  };

  const handleDeleteWorkflow = (force?: boolean) => {
    const title = force ? "Delete Workflow and All Runs" : "Delete Workflow";
    const message = force
      ? `Are you sure you want to delete "${workflowName}" and all its execution history? This cannot be undone.`
      : `Are you sure you want to delete "${workflowName}"? This will permanently delete the workflow. This cannot be undone.`;
    const confirmLabel = force ? "Delete Everything" : "Delete Workflow";

    openOverlay(ConfirmOverlay, {
      title,
      message,
      confirmLabel,
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: async () => {
        // biome-ignore lint/style/useBlockStatements: upstream code
        if (!currentWorkflowId) return;
        try {
          await api.workflow.delete(currentWorkflowId, { force });
          toast.success("Workflow deleted successfully");
          window.location.href = "/";
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            !force
          ) {
            handleDeleteWorkflow(true);
            return;
          }
          toast.error("Failed to delete workflow. Please try again.");
        }
      },
    });
  };

  const handleDownload = async () => {
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before downloading");
      return;
    }

    setIsDownloading(true);
    toast.info("Preparing workflow files for download...");

    try {
      const result = await api.workflow.download(currentWorkflowId);

      if (!result.success) {
        throw new Error(result.error || "Failed to prepare download");
      }

      if (!result.files) {
        throw new Error("No files to download");
      }

      // Import JSZip dynamically
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();

      // Add all files to the zip
      for (const [path, content] of Object.entries(result.files)) {
        zip.file(path, content);
      }

      // Generate the zip file
      const blob = await zip.generateAsync({ type: "blob" });

      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${workflowName.toLowerCase().replace(/[^a-z0-9]/g, "-")}-workflow.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("Workflow downloaded successfully!");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to download workflow"
      );
    } finally {
      setIsDownloading(false);
    }
  };

  const loadWorkflows = async () => {
    try {
      const [workflows, projects, tags] = await Promise.all([
        api.workflow.getAll(),
        api.project.getAll().catch(() => [] as Project[]),
        api.tag.getAll().catch(() => [] as Tag[]),
      ]);
      setAllWorkflows(workflows);
      setAllProjects(projects);
      setAllTags(tags);
    } catch (error) {
      console.error("Failed to load workflows:", error);
    }
  };

  const handleToggleVisibility = async (newVisibility: WorkflowVisibility) => {
    if (!currentWorkflowId) {
      return;
    }

    // Show Share overlay when making public
    if (newVisibility === "public") {
      openOverlay(GoLiveOverlay, {
        workflowId: currentWorkflowId,
        currentName: workflowName,
        orgTagNames: allTags.map((t) => t.name),
        onConfirm: ({ name, publicTags }) => {
          setWorkflowVisibility("public");
          setWorkflowPublicTags(publicTags);
          if (name !== workflowName) {
            state.setCurrentWorkflowName(name);
          }
          toast.success("Workflow is now live");
        },
      });
      return;
    }

    // Switch to private immediately (no risks)
    try {
      await api.workflow.update(currentWorkflowId, {
        visibility: newVisibility,
      });
      setWorkflowVisibility(newVisibility);
      setWorkflowPublicTags([]); // keeperhub custom field //
      toast.success("Workflow is now private");
    } catch (error) {
      console.error("Failed to update visibility:", error);
      toast.error("Failed to update visibility. Please try again.");
    }
  };

  const handleEditPublicSettings = (): void => {
    if (!currentWorkflowId) {
      return;
    }
    openOverlay(GoLiveOverlay, {
      workflowId: currentWorkflowId,
      currentName: workflowName,
      orgTagNames: allTags.map((t) => t.name),
      initialTags: workflowPublicTags,
      isEditing: true,
      onConfirm: ({ name, publicTags }) => {
        setWorkflowPublicTags(publicTags);
        if (name !== workflowName) {
          state.setCurrentWorkflowName(name);
        }
        toast.success("Share settings updated");
      },
    });
  };

  const updateWorkflowEnabled = async (enabled: boolean) => {
    if (!currentWorkflowId) {
      return;
    }

    try {
      await api.workflow.update(currentWorkflowId, {
        enabled,
      });
      state.setIsEnabled(enabled);
      toast.success(enabled ? "Workflow enabled" : "Workflow disabled");
    } catch (error) {
      console.error("Failed to update enabled state:", error);
      toast.error("Failed to update workflow state. Please try again.");
    }
  };

  const handleToggleEnabled = async (newEnabled: boolean) => {
    if (!currentWorkflowId) {
      return;
    }

    // When disabling, update directly without validation
    if (!newEnabled) {
      await updateWorkflowEnabled(false);
      return;
    }

    // When enabling, check if user is logged in (not anonymous)
    if (isAnonymousUser(session?.user)) {
      toast.error("Please sign in to activate your workflow");
      return;
    }

    // When enabling, validate first
    if (
      validateAndProceed(() => updateWorkflowEnabled(true), "Enable Anyway")
    ) {
      await updateWorkflowEnabled(true);
    }
  };

  const handleDuplicate = async () => {
    if (!currentWorkflowId) {
      return;
    }

    setIsDuplicating(true);
    try {
      // Auto-sign in as anonymous if user has no session
      if (!session?.user) {
        await authClient.signIn.anonymous();
        // Wait for session to be established
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const newWorkflow = await api.workflow.duplicate(currentWorkflowId);
      toast.success("Workflow duplicated successfully");
      router.push(`/workflows/${newWorkflow.id}`);
    } catch (error) {
      console.error("Failed to duplicate workflow:", error);
      toast.error("Failed to duplicate workflow. Please try again.");
    } finally {
      setIsDuplicating(false);
    }
  };

  return {
    handleSave,
    handleExecute,
    handleCancel,
    handleClearWorkflow,
    handleDeleteWorkflow,
    handleDownload,
    loadWorkflows,
    handleToggleVisibility,
    handleEditPublicSettings, // keeperhub custom field //
    handleToggleEnabled,
    handleDuplicate,
  };
}

// Toolbar Actions Component - handles add step, undo/redo, save, and run buttons
function ToolbarActions({
  workflowId,
  state,
  actions,
}: {
  workflowId?: string;
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const { open: openOverlay, push } = useOverlay();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const { screenToFlowPosition } = useReactFlow();

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const hasSelection = selectedNode || selectedEdge;

  // For non-owners viewing public workflows, don't show toolbar actions
  // (Duplicate button is now in the main toolbar next to Sign In)
  if (workflowId && !state.isOwner) {
    return null;
  }

  if (!workflowId) {
    return null;
  }

  const handleDeleteConfirm = () => {
    const isNode = Boolean(selectedNodeId);
    const itemType = isNode ? "Node" : "Connection";

    push(ConfirmOverlay, {
      title: `Delete ${itemType}`,
      message: `Are you sure you want to delete this ${itemType.toLowerCase()}? This action cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      onConfirm: () => {
        if (selectedNodeId) {
          deleteNode(selectedNodeId);
        } else if (selectedEdgeId) {
          deleteEdge(selectedEdgeId);
        }
      },
    });
  };

  const handleAddStep = () => {
    // Get the ReactFlow wrapper (the visible canvas container)
    const flowWrapper = document.querySelector(".react-flow");
    if (!flowWrapper) {
      return;
    }

    const rect = flowWrapper.getBoundingClientRect();
    // Calculate center in absolute screen coordinates
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Convert to flow coordinates
    const position = screenToFlowPosition({ x: centerX, y: centerY });

    // Adjust for node dimensions to center it properly
    // Action node is 192px wide and 192px tall (w-48 h-48 in Tailwind)
    const nodeWidth = 192;
    const nodeHeight = 192;
    position.x -= nodeWidth / 2;
    position.y -= nodeHeight / 2;

    // Check if there's already a node at this position
    const offset = 20; // Offset distance in pixels
    const threshold = 20; // How close nodes need to be to be considered overlapping

    const finalPosition = { ...position };
    let hasOverlap = true;
    let attempts = 0;
    const maxAttempts = 20; // Prevent infinite loop

    while (hasOverlap && attempts < maxAttempts) {
      hasOverlap = state.nodes.some((node) => {
        const dx = Math.abs(node.position.x - finalPosition.x);
        const dy = Math.abs(node.position.y - finalPosition.y);
        return dx < threshold && dy < threshold;
      });

      if (hasOverlap) {
        // Offset diagonally down-right
        finalPosition.x += offset;
        finalPosition.y += offset;
        attempts += 1;
      }
    }

    // Create new action node
    const newNode: WorkflowNode = {
      id: nanoid(),
      type: "action",
      position: finalPosition,
      data: {
        label: "",
        description: "",
        type: "action",
        config: {},
        status: "idle",
      },
    };

    state.addNode(newNode);
    state.setSelectedNodeId(newNode.id);
    state.setActiveTab("properties");
  };

  const triggerType = state.nodes.find((node) => node?.data?.type === "trigger")
    ?.data?.config?.triggerType;

  const shouldDisplayEnableWorkflowSwitch =
    triggerType === WorkflowTriggerEnum.EVENT ||
    triggerType === WorkflowTriggerEnum.SCHEDULE ||
    triggerType === WorkflowTriggerEnum.BLOCK;

  return (
    <>
      {/* Properties - Mobile Vertical (always visible) */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <Button
          className="border hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => openOverlay(ConfigurationOverlay, {})}
          size="icon"
          title="Configuration"
          variant="secondary"
        >
          <Settings2 className="size-4" />
        </Button>
        {/* Delete - Show when node or edge is selected */}
        {hasSelection && (
          <Button
            className="border hover:bg-black/5 dark:hover:bg-white/5"
            onClick={handleDeleteConfirm}
            size="icon"
            title="Delete"
            variant="secondary"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </ButtonGroup>

      {/* Save/Download - Mobile Vertical */}
      <div className="flex flex-col gap-1 lg:hidden">
        <SaveButton handleSave={actions.handleSave} state={state} />
        <DownloadButton actions={actions} state={state} />
      </div>

      {/* Save/Download - Desktop Horizontal */}
      <div className="hidden items-center gap-2 lg:flex">
        {state.isSaving && !isAnonymousUser(state.session?.user) && (
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <Loader2 className="size-3 animate-spin" />
            Saving...
          </span>
        )}
        <SaveButton handleSave={actions.handleSave} state={state} />
        <DownloadButton actions={actions} state={state} />
      </div>

      {/* Visibility Toggle */}
      <VisibilityButton actions={actions} state={state} />

      {shouldDisplayEnableWorkflowSwitch && (
        <button
          className="relative hidden h-8 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:inline-flex"
          onClick={() => actions.handleToggleEnabled(!state.isEnabled)}
          style={{
            width: 98,
            backgroundColor: state.isEnabled
              ? "var(--color-keeperhub-green)"
              : "var(--color-input)",
          }}
          title={state.isEnabled ? "Disable workflow" : "Enable workflow"}
          type="button"
        >
          <span
            className="pointer-events-none absolute inset-0 flex items-center pl-3 pr-2 font-medium text-sm transition-opacity"
            style={{
              justifyContent: "flex-start",
              opacity: state.isEnabled ? 1 : 0,
              color: "var(--color-background)",
            }}
          >
            Disable
          </span>
          <span
            className="pointer-events-none absolute inset-0 flex items-center pl-2 pr-3 font-medium text-sm transition-opacity"
            style={{
              justifyContent: "flex-end",
              opacity: state.isEnabled ? 0 : 1,
              color: "var(--color-foreground)",
            }}
          >
            Enable
          </span>
          <span
            className="pointer-events-none block size-6 rounded-full bg-background shadow-lg ring-0 transition-transform"
            style={{
              transform: state.isEnabled
                ? "translateX(66px)"
                : "translateX(2px)",
            }}
          />
        </button>
      )}

      <RunButtonGroup actions={actions} state={state} />
    </>
  );
}

// Save Button Component
function SaveButton({
  state,
  handleSave,
}: {
  state: ReturnType<typeof useWorkflowState>;
  handleSave: () => Promise<void>;
}) {
  const isAnonymous = isAnonymousUser(state.session?.user);
  const disabled =
    isAnonymous ||
    !state.currentWorkflowId ||
    state.isGenerating ||
    state.isSaving;

  const button = (
    <Button
      className="relative border hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5 disabled:[&>svg]:text-muted-foreground"
      disabled={disabled}
      onClick={handleSave}
      size="icon"
      title={
        isAnonymous
          ? "Sign in to save workflows"
          : state.isSaving
            ? "Saving..."
            : "Save workflow"
      }
      variant="secondary"
    >
      <Save className="size-4" />
      {state.hasUnsavedChanges && !state.isSaving && !isAnonymous && (
        <div className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
      )}
    </Button>
  );

  if (isAnonymous) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">{button}</span>
        </TooltipTrigger>
        <TooltipContent>Sign in to save workflows</TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

// Download Button Component
function DownloadButton({
  state,
  actions,
}: {
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const { open: openOverlay } = useOverlay();

  const handleClick = () => {
    openOverlay(ExportWorkflowOverlay, {
      onExport: actions.handleDownload,
      isDownloading: state.isDownloading,
    });
  };

  return (
    <Button
      className="border hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5 disabled:[&>svg]:text-muted-foreground"
      disabled={
        state.isDownloading ||
        state.nodes.length === 0 ||
        state.isGenerating ||
        !state.currentWorkflowId
      }
      onClick={handleClick}
      size="icon"
      title={
        state.isDownloading
          ? "Preparing download..."
          : "Export workflow as code"
      }
      variant="secondary"
    >
      {state.isDownloading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Download className="size-4" />
      )}
    </Button>
  );
}

// Visibility Button Component
function VisibilityButton({
  state,
  actions,
}: {
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const isPublic = state.workflowVisibility === "public";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={
            isPublic
              ? "border border-keeperhub-green/20 text-keeperhub-green hover:bg-keeperhub-green/10"
              : "border hover:bg-black/5 dark:hover:bg-white/5"
          }
          disabled={!state.currentWorkflowId || state.isGenerating}
          size="icon"
          title={isPublic ? "Shared workflow" : "Private workflow"}
          variant="secondary"
        >
          {isPublic ? (
            <Share2 className="size-4" />
          ) : (
            <Lock className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="flex items-center gap-2"
          onClick={() => actions.handleToggleVisibility("private")}
        >
          <Lock className="size-4" />
          Private
          {!isPublic && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        {isPublic ? (
          <DropdownMenuItem
            className="flex items-center gap-2"
            onClick={() => actions.handleEditPublicSettings()}
          >
            <Settings2 className="size-4" />
            Share Settings
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            className="flex items-center gap-2"
            onClick={() => actions.handleToggleVisibility("public")}
          >
            <Share2 className="size-4" />
            Share
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Run Button Group Component
function RunButtonGroup({
  state,
  actions,
}: {
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const triggerType = state.nodes.find((node) => node.data.type === "trigger")
    ?.data.config?.triggerType;

  const isNonManualTrigger =
    triggerType === WorkflowTriggerEnum.EVENT ||
    triggerType === WorkflowTriggerEnum.BLOCK;

  const disabled =
    state.isExecuting ||
    state.nodes.length === 0 ||
    state.isGenerating ||
    isNonManualTrigger;

  // Show Stop button while executing
  if (state.isExecuting) {
    return (
      <Button
        className="min-w-20 bg-destructive text-white hover:bg-destructive/90"
        onClick={() => actions.handleCancel()}
        title="Stop Execution"
      >
        <div className="flex items-center gap-2">
          <Square className="size-3.5 fill-current" /> Stop
        </div>
      </Button>
    );
  }

  const button = (
    <Button
      className="min-w-20 bg-keeperhub-green hover:bg-keeperhub-green-dark disabled:opacity-70 disabled:[&>svg]:text-muted-foreground"
      disabled={disabled}
      onClick={() => actions.handleExecute()}
      title="Run Workflow"
    >
      <div className="flex items-center gap-2">
        <Play className="size-4" /> Run
      </div>
    </Button>
  );

  if (isNonManualTrigger) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* inline block to prevent tooltip from being cut off when the button is disabled */}
            <span className="inline-block">{button}</span>
          </TooltipTrigger>
          <TooltipContent align="center" side="bottom">
            {`Manual runs are not available for Workflows with ${triggerType} trigger`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
}

// Read-only badge - pill with a live green accent on the toolbar
function ReadOnlyBadge({ className }: { className?: string }) {
  return (
    <Badge
      className={cn(
        "border-keeperhub-green/60 bg-keeperhub-green/10 font-medium text-foreground/90 uppercase backdrop-blur-sm dark:border-keeperhub-green/50 dark:bg-transparent",
        className
      )}
      variant="outline"
    >
      Preview
    </Badge>
  );
}

// Duplicate Button Component - placed next to Sign In for non-owners
function DuplicateButton({
  isDuplicating,
  onDuplicate,
}: {
  isDuplicating: boolean;
  onDuplicate: () => void;
}) {
  return (
    <Button
      className="h-9 border hover:bg-black/5 dark:hover:bg-white/5"
      disabled={isDuplicating}
      onClick={onDuplicate}
      size="sm"
      title="Duplicate to your workflows"
      variant="secondary"
    >
      {isDuplicating ? (
        <Loader2 className="mr-2 size-4 animate-spin" />
      ) : (
        <Copy className="mr-2 size-4" />
      )}
      Duplicate
    </Button>
  );
}

// Workflow Menu Component
function WorkflowMenuComponent({
  workflowId,
  state,
}: {
  workflowId?: string;
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const pathname = usePathname();
  const isWorkflowRoute = pathname.startsWith("/workflows/");

  return (
    <div className="flex flex-col gap-1">
      {isWorkflowRoute && workflowId && !state.isOwner && (
        <ReadOnlyBadge className="lg:hidden" />
      )}
    </div>
  );
}

export const WorkflowToolbar = ({
  workflowId,
  persistent = false,
}: WorkflowToolbarProps) => {
  const state = useWorkflowState();
  const actions = useWorkflowActions(state);

  // Use prop if provided, otherwise fall back to atom value
  const effectiveWorkflowId =
    workflowId ?? state.currentWorkflowId ?? undefined;

  const pathname = usePathname();
  const isWorkflowRoute = pathname.startsWith("/workflows/");

  // If persistent mode, use fixed positioning
  const containerClassName = persistent
    ? "pointer-events-auto fixed top-0 right-0 left-0 z-50 flex items-center justify-between border-b bg-background px-4 py-3"
    : "";

  const leftSectionClassName = persistent
    ? "flex items-center gap-2"
    : "flex flex-col gap-2 rounded-none border-none bg-transparent p-0 lg:flex-row lg:items-center";

  const rightSectionClassName = persistent
    ? "flex items-center gap-2"
    : "pointer-events-auto absolute top-4 right-4 z-10";

  const rightContentClassName = persistent
    ? "flex items-center gap-2"
    : "flex flex-col-reverse items-end gap-2 lg:flex-row lg:items-center";

  if (persistent) {
    return (
      <div className={containerClassName}>
        {/* Left side: Logo + Menu + Org Switcher */}
        <div className={leftSectionClassName}>
          {(() => {
            const CustomLogo = getCustomLogo();
            return CustomLogo ? (
              <a href="/">
                <CustomLogo className="size-7 shrink-0" />
              </a>
            ) : null;
          })()}
          <div className="hidden ml-2 lg:block">
            <OrgSwitcher />
          </div>
          <WorkflowMenuComponent
            actions={actions}
            state={state}
            workflowId={effectiveWorkflowId}
          />
          {isWorkflowRoute && effectiveWorkflowId && !state.isOwner && (
            <ReadOnlyBadge className="hidden lg:inline-flex" />
          )}
        </div>

        {/* Right side: Actions + User Menu */}
        <div className={rightSectionClassName}>
          <div className={rightContentClassName}>
            {isWorkflowRoute && (
              <ToolbarActions
                actions={actions}
                state={state}
                workflowId={effectiveWorkflowId}
              />
            )}
            <div className="flex items-center gap-2">
              {isWorkflowRoute && effectiveWorkflowId && !state.isOwner && (
                <DuplicateButton
                  isDuplicating={state.isDuplicating}
                  onDuplicate={actions.handleDuplicate}
                />
              )}
              <UserMenu />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Original non-persistent layout for workflow canvas
  return (
    <>
      <Panel
        className="flex flex-col gap-2 rounded-none border-none bg-transparent p-0 lg:flex-row lg:items-center"
        position="top-left"
      >
        <div className="flex items-center gap-2">
          {(() => {
            const CustomLogo = getCustomLogo();
            return CustomLogo ? (
              <a href="/">
                <CustomLogo className="size-7 shrink-0" />
              </a>
            ) : null;
          })()}
          <div className="hidden ml-2 lg:block">
            <OrgSwitcher />
          </div>
          <WorkflowMenuComponent
            actions={actions}
            state={state}
            workflowId={effectiveWorkflowId}
          />
          {isWorkflowRoute && effectiveWorkflowId && !state.isOwner && (
            <ReadOnlyBadge className="hidden lg:inline-flex" />
          )}
        </div>
      </Panel>

      <div className="pointer-events-auto absolute top-4 right-4 z-10">
        <div className="flex flex-col-reverse items-end gap-2 lg:flex-row lg:items-center">
          {isWorkflowRoute && (
            <ToolbarActions
              actions={actions}
              state={state}
              workflowId={effectiveWorkflowId}
            />
          )}
          <div className="flex items-center gap-2">
            {isWorkflowRoute && effectiveWorkflowId && !state.isOwner && (
              <DuplicateButton
                isDuplicating={state.isDuplicating}
                onDuplicate={actions.handleDuplicate}
              />
            )}
            <UserMenu />
          </div>
        </div>
      </div>
    </>
  );
};
