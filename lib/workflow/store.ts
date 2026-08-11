import type { Edge, EdgeChange, Node, NodeChange } from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { atom } from "jotai";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { ErrorCategory, logSystemError, logUserError } from "@/lib/logging";
import { computeAutoLayout } from "@/lib/workflow/editor/auto-layout";
import { buildExecutionLogsMap } from "@/lib/workflow/editor/template-helpers";

export type WorkflowNodeType = "trigger" | "action" | "add";

// biome-ignore lint/style/noEnum: Prefer to use enums as make it easier to maintain and read.
export enum WorkflowTriggerEnum {
  MANUAL = "Manual",
  SCHEDULE = "Schedule",
  WEBHOOK = "Webhook",
  EVENT = "Event", // keeperhub custom field //
  BLOCK = "Block", // keeperhub custom field //
  TEMPO_PAYMENT = "Transfer", // keeperhub custom field //
}

export type WorkflowTriggerType = `${WorkflowTriggerEnum}`;

// Trigger types that need a UI toggle to flip `workflows.enabled`.
// Server-side gates (schedule/event/block/webhook) all check this column,
// so a disabled workflow keeps the trigger registered but rejects executions.
// Manual triggers don't fire on their own, so the switch isn't needed there.
export function shouldShowEnableSwitch(
  triggerType: WorkflowTriggerType | undefined
): boolean {
  return (
    triggerType === WorkflowTriggerEnum.EVENT ||
    triggerType === WorkflowTriggerEnum.SCHEDULE ||
    triggerType === WorkflowTriggerEnum.BLOCK ||
    triggerType === WorkflowTriggerEnum.WEBHOOK ||
    triggerType === WorkflowTriggerEnum.TEMPO_PAYMENT
  );
}

/**
 * Pull the trigger type off the trigger node in a workflow's node list.
 * Used by surfaces that need to gate behavior on what fires the workflow
 * without dragging the full editor store into view -- e.g. the sidebar
 * picker deciding whether to surface a "Disabled" label.
 */
export function getWorkflowTriggerType(
  nodes: Array<{ data?: { type?: string; config?: Record<string, unknown> } }>
): WorkflowTriggerType | undefined {
  const triggerNode = nodes.find((node) => node.data?.type === "trigger");
  const raw = triggerNode?.data?.config?.triggerType;
  if (typeof raw !== "string") {
    return undefined;
  }
  // "Scheduled" is a legacy spelling that still lives in some workflow rows;
  // executor / metrics / mcp normalize it the same way before comparing.
  const normalized = raw === "Scheduled" ? "Schedule" : raw;
  return normalized as WorkflowTriggerType;
}

/**
 * Show the "Disabled" label in the sidebar picker only when the workflow has
 * a trigger type whose schedule the user can actually flip with the enable
 * switch. Manual workflows persist `enabled = false` by default but can't be
 * disabled through the UI -- labeling them would be noise.
 */
export function shouldShowDisabledBadge(workflow: {
  enabled?: boolean | null;
  triggerType?: WorkflowTriggerType | null;
}): boolean {
  if (workflow.enabled !== false) {
    return false;
  }
  return shouldShowEnableSwitch(workflow.triggerType ?? undefined);
}

export type WorkflowNodeData = {
  label: string;
  description?: string;
  type: WorkflowNodeType;
  config?: Record<string, unknown>;
  status?: "idle" | "running" | "success" | "error";
  enabled?: boolean; // Whether the step is enabled (defaults to true)
  onClick?: () => void; // For the "add" node type
};

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

// Workflow visibility type
// - private: only owner / org members can view (default)
// - unlisted: anyone with the URL can view read-only; not surfaced in Hub feed
// - public: viewable by anyone AND listed on the Hub
export type WorkflowVisibility = "private" | "unlisted" | "public";

// Atoms for workflow state (now backed by database)
export const nodesAtom = atom<WorkflowNode[]>([]);
export const edgesAtom = atom<WorkflowEdge[]>([]);

// When non-null, the canvas is showing a historical version (read-only
// preview from the version-history overlay). Autosave is suppressed while
// this is set so previewing a past version can never clobber the live
// workflow via the debounced save.
export const previewVersionAtom = atom<number | null>(null);
// Whether the right-docked version-history panel is open in the editor.
export const versionHistoryOpenAtom = atom(false);
export const selectedNodeAtom = atom<string | null>(null);
export const selectedEdgeAtom = atom<string | null>(null);
export const isExecutingAtom = atom(false);
export const isLoadingAtom = atom(false);
export const isGeneratingAtom = atom(false);
export const currentWorkflowIdAtom = atom<string | null>(null);
export const currentWorkflowNameAtom = atom<string>("");
export const currentWorkflowDescriptionAtom = atom<string>("");
export const currentWorkflowProjectIdAtom = atom<string | null>(null);
export const currentWorkflowTagIdAtom = atom<string | null>(null);
export const currentWorkflowVisibilityAtom =
  atom<WorkflowVisibility>("private");
export const currentWorkflowPublicTagsAtom = atom<
  Array<{ id: string; name: string; slug: string }>
>([]);
export const isWorkflowOwnerAtom = atom<boolean>(true); // Whether current user owns this workflow
export const isWorkflowEnabled = atom<boolean>(false);

// v1.7 listing state atoms
export const currentWorkflowIsListedAtom = atom<boolean>(false);
export const currentWorkflowListedSlugAtom = atom<string | null>(null);
export const currentWorkflowListedAtAtom = atom<string | null>(null);
export const currentWorkflowInputSchemaAtom = atom<Record<
  string,
  unknown
> | null>(null);
export const currentWorkflowOutputMappingAtom = atom<Record<
  string,
  unknown
> | null>(null);
export const currentWorkflowPriceUsdcAtom = atom<string | null>(null);
export const currentWorkflowShareExecutionStatusAtom = atom<boolean>(false);

// UI state atoms
export const propertiesPanelActiveTabAtom = atom<string>("properties");
// Increment to trigger an immediate Runs panel refresh (e.g. after execute)
export const runsRefreshTriggerAtom = atom<number>(0);
export const showMinimapAtom = atom(false);
export const selectedExecutionIdAtom = atom<string | null>(null);
export const rightPanelWidthAtom = atom<string | null>(null);
// Width (in viewport %) shared by the right-docked editor panels (node config
// + version history) so they stay the same size and a resize on either keeps
// them in sync. Clamp 20-50 when writing.
export const rightPanelWidthPctAtom = atom(30);
export const isPanelAnimatingAtom = atom<boolean>(false);
export const hasSidebarBeenShownAtom = atom<boolean>(false);
export const isSidebarCollapsedAtom = atom<boolean>(false);
export const isTransitioningFromHomepageAtom = atom<boolean>(false);

// Set to true by the "Take a tour" button to launch the interactive editor
// walkthrough; consumed and reset by the walkthrough controller once it starts.
export const editorTourRequestedAtom = atom<boolean>(false);

// Forces the getting-started launcher open/expanded. Set by the user-menu
// "Getting started" entry so a dismissed launcher can be reopened.
export const gettingStartedOpenAtom = atom<boolean>(false);

// A getting-started chip seeds a preset prompt here, then navigates to a fresh
// builder. The AI prompt box (components/ai-elements/prompt.tsx) consumes it on
// mount, prefills + generates, and resets to null.
export const pendingAiPromptAtom = atom<string | null>(null);

// Set to a node id to focus/center that node in the React Flow canvas. A bridge
// in WorkflowCanvas (which has useReactFlow) consumes it and resets to null.
export const centerNodeAtom = atom<string | null>(null);

// Tracks nodes that are pending integration auto-select check
// Don't show "missing integration" warning for these nodes
export const pendingIntegrationNodesAtom = atom<Set<string>>(new Set<string>());

// Tracks the ID of a newly created node (for auto-focusing search input)
// Cleared when the node gets an action type or is deselected
export const newlyCreatedNodeIdAtom = atom<string | null>(null);

// Tracks the execution ID of the currently running execution (for cancel support)
export const currentExecutionIdAtom = atom<string | null>(null);

// Trigger execute atom - set to true to trigger workflow execution
// This allows keyboard shortcuts to trigger the same execute flow as the button
export const triggerExecuteAtom = atom(false);

// Execution log entry type for storing run outputs per node
export type ExecutionLogEntry = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  output?: unknown;
};

// Map of nodeId -> execution log entry for the currently selected execution
export const executionLogsAtom = atom<Record<string, ExecutionLogEntry>>({});

// Last execution logs per workflow (for template autocomplete when no run is selected)
export type LastExecutionLogsState = {
  workflowId: string | null;
  logs: Record<string, ExecutionLogEntry>;
};

export const lastExecutionLogsAtom = atom<LastExecutionLogsState>({
  workflowId: null,
  logs: {},
});

// Autosave functionality
let autosaveTimeoutId: NodeJS.Timeout | null = null;
const AUTOSAVE_DELAY = 2500; // debounce so rapid edits don't each save/version

/**
 * Cancel a scheduled (debounced) autosave. Called after an out-of-band save
 * (manual Save, pre-run flush) so the already-scheduled debounced write does
 * not fire redundantly after a fresher save has landed.
 */
export function cancelPendingAutosave(): void {
  if (autosaveTimeoutId) {
    clearTimeout(autosaveTimeoutId);
    autosaveTimeoutId = null;
  }
}

// Autosave atom that handles saving workflow state
export const autosaveAtom = atom(
  null,
  async (get, set, options?: { immediate?: boolean }) => {
    const workflowId = get(currentWorkflowIdAtom);
    const nodes = get(nodesAtom);
    const edges = get(edgesAtom);

    // Only autosave if we have a workflow ID
    if (!workflowId) {
      return;
    }

    // Never autosave while previewing a historical version -- the canvas is
    // showing an old snapshot, not the user's working edits.
    if (get(previewVersionAtom) !== null) {
      return;
    }

    const saveFunc = async () => {
      try {
        set(isSavingAtom, true);
        await api.workflow.update(workflowId, { nodes, edges });
        // Clear the unsaved changes indicator after successful save
        set(hasUnsavedChangesAtom, false);
      } catch (error) {
        // Leave hasUnsavedChangesAtom set (only cleared on success) and tell the
        // user: a rejected save - e.g. the server refusing an out-of-org
        // connection reference - must not fail silently.
        logUserError(
          ErrorCategory.VALIDATION,
          "[Workflow] Autosave failed",
          error
        );
        toast.error("Couldn't save workflow changes. Please try again.");
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 800));
        set(isSavingAtom, false);
      }
    };

    if (options?.immediate) {
      // Save immediately (for add/delete/connect operations); drop any
      // pending debounced save so it doesn't re-fire with an older snapshot
      cancelPendingAutosave();
      await saveFunc();
    } else {
      // Debounce for typing operations
      if (autosaveTimeoutId) {
        clearTimeout(autosaveTimeoutId);
      }
      autosaveTimeoutId = setTimeout(saveFunc, AUTOSAVE_DELAY);
    }
  }
);

// Derived atoms for node/edge operations
export const onNodesChangeAtom = atom(
  null,
  (get, set, changes: NodeChange[]) => {
    const currentNodes = get(nodesAtom);

    // Filter out deletion attempts on trigger nodes
    const filteredChanges = changes.filter((change) => {
      if (change.type === "remove") {
        const nodeToRemove = currentNodes.find((n) => n.id === change.id);
        // Prevent deletion of trigger nodes
        return nodeToRemove?.data.type !== "trigger";
      }
      return true;
    });

    const newNodes = applyNodeChanges(
      filteredChanges,
      currentNodes
    ) as WorkflowNode[];
    set(nodesAtom, newNodes);

    // Sync selection state with selectedNodeAtom
    const selectedNode = newNodes.find((n) => n.selected);
    if (selectedNode) {
      set(selectedNodeAtom, selectedNode.id);
      // Clear edge selection when a node is selected
      set(selectedEdgeAtom, null);
      // Clear newly created node tracking if a different node is selected
      const newlyCreatedId = get(newlyCreatedNodeIdAtom);
      if (newlyCreatedId && newlyCreatedId !== selectedNode.id) {
        set(newlyCreatedNodeIdAtom, null);
      }
    } else if (get(selectedNodeAtom)) {
      // If no node is selected in ReactFlow but we have a selection, clear it
      const currentSelection = get(selectedNodeAtom);
      const stillExists = newNodes.find((n) => n.id === currentSelection);
      if (!stillExists) {
        set(selectedNodeAtom, null);
      }
      // Clear newly created node tracking when no node is selected
      set(newlyCreatedNodeIdAtom, null);
    }

    // Check if there were any deletions to trigger immediate save
    const hadDeletions = filteredChanges.some(
      (change) => change.type === "remove"
    );
    if (hadDeletions) {
      set(autosaveAtom, { immediate: true });
      return;
    }

    // Check if there were any position changes (node moved) to trigger debounced save
    const hadPositionChanges = filteredChanges.some(
      (change) => change.type === "position" && change.dragging === false
    );
    if (hadPositionChanges) {
      set(autosaveAtom); // Debounced save
    }
  }
);

export const onEdgesChangeAtom = atom(
  null,
  (get, set, changes: EdgeChange[]) => {
    const currentEdges = get(edgesAtom);
    const newEdges = applyEdgeChanges(changes, currentEdges) as WorkflowEdge[];
    set(edgesAtom, newEdges);

    // Sync selection state with selectedEdgeAtom
    const selectedEdge = newEdges.find((e) => e.selected);
    if (selectedEdge) {
      set(selectedEdgeAtom, selectedEdge.id);
      // Clear node selection when an edge is selected
      set(selectedNodeAtom, null);
    } else if (get(selectedEdgeAtom)) {
      // If no edge is selected in ReactFlow but we have a selection, clear it
      const currentSelection = get(selectedEdgeAtom);
      const stillExists = newEdges.find((e) => e.id === currentSelection);
      if (!stillExists) {
        set(selectedEdgeAtom, null);
      }
    }

    // Check if there were any deletions to trigger immediate save
    const hadDeletions = changes.some((change) => change.type === "remove");
    if (hadDeletions) {
      set(autosaveAtom, { immediate: true });
    }
  }
);

export const addNodeAtom = atom(null, (get, set, node: WorkflowNode) => {
  // Save current state to history before making changes
  const currentNodes = get(nodesAtom);
  const currentEdges = get(edgesAtom);
  const history = get(historyAtom);
  set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
  set(futureAtom, []);

  // Deselect all existing nodes and add new node as selected.
  // Only spread nodes whose selected state actually changes to preserve
  // object references -- React Flow re-measures handle bounds when node
  // objects change, which temporarily unregisters named handles (e.g.
  // For Each "loop"/"done") and breaks concurrent edge creation.
  const updatedNodes = currentNodes.map((n) =>
    n.selected ? { ...n, selected: false } : n
  );
  const newNode = { ...node, selected: true };
  const newNodes = [...updatedNodes, newNode];
  set(nodesAtom, newNodes);

  // Auto-select the newly added node
  set(selectedNodeAtom, node.id);

  // Track newly created action nodes (for auto-focusing search input)
  if (node.data.type === "action" && !node.data.config?.actionType) {
    set(newlyCreatedNodeIdAtom, node.id);
  }

  // Mark as having unsaved changes
  set(hasUnsavedChangesAtom, true);

  // Trigger immediate autosave
  set(autosaveAtom, { immediate: true });
});

export const autoLayoutAtom = atom(null, (get, set) => {
  const currentNodes = get(nodesAtom);
  const currentEdges = get(edgesAtom);

  // Save current state to history for undo support
  const history = get(historyAtom);
  set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
  set(futureAtom, []);

  const positions = computeAutoLayout(currentNodes, currentEdges);

  // Only create new object references for nodes whose position actually changed.
  // Preserving references prevents React Flow from re-triggering selection/layout handlers.
  const updatedNodes = currentNodes.map((node) => {
    const pos = positions.get(node.id);
    if (pos && (node.position.x !== pos.x || node.position.y !== pos.y)) {
      return { ...node, position: pos };
    }
    return node;
  });

  set(nodesAtom, updatedNodes);
  set(hasUnsavedChangesAtom, true);
  set(autosaveAtom, { immediate: true });
});

export const updateNodeDataAtom = atom(
  null,
  (get, set, { id, data }: { id: string; data: Partial<WorkflowNodeData> }) => {
    const currentNodes = get(nodesAtom);

    // Check if label is being updated
    const oldNode = currentNodes.find((node) => node.id === id);
    const oldLabel = oldNode?.data.label;
    const newLabel = data.label;
    const isLabelChange = newLabel !== undefined && oldLabel !== newLabel;

    const newNodes = currentNodes.map((node) => {
      if (node.id === id) {
        // Update the node itself
        return { ...node, data: { ...node.data, ...data } };
      }

      // If label changed, update all templates in other nodes that reference this node
      if (isLabelChange && oldLabel) {
        const updatedConfig = updateTemplatesInConfig(
          node.data.config || {},
          id,
          oldLabel,
          newLabel
        );

        if (updatedConfig !== node.data.config) {
          return {
            ...node,
            data: {
              ...node.data,
              config: updatedConfig,
            },
          };
        }
      }

      return node;
    });

    set(nodesAtom, newNodes);

    // Mark as having unsaved changes (except for status updates during execution)
    if (!data.status) {
      set(hasUnsavedChangesAtom, true);
      // Trigger debounced autosave (for typing)
      set(autosaveAtom);
    }
  }
);

// Helper function to update templates in a config object when a node label changes
function updateTemplatesInConfig(
  config: Record<string, unknown>,
  nodeId: string,
  oldLabel: string,
  newLabel: string
): Record<string, unknown> {
  let hasChanges = false;
  const updated: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      // Update template references to this node
      // Pattern: {{@nodeId:OldLabel}} or {{@nodeId:OldLabel.field}}
      const pattern = new RegExp(
        `\\{\\{@${escapeRegex(nodeId)}:${escapeRegex(oldLabel)}(\\.[^}]+)?\\}\\}`,
        "g"
      );
      const newValue = value.replace(pattern, (_match, fieldPart) => {
        hasChanges = true;
        return `{{@${nodeId}:${newLabel}${fieldPart || ""}}}`;
      });
      updated[key] = newValue;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const nestedUpdated = updateTemplatesInConfig(
        value as Record<string, unknown>,
        nodeId,
        oldLabel,
        newLabel
      );
      if (nestedUpdated !== value) {
        hasChanges = true;
      }
      updated[key] = nestedUpdated;
    } else {
      updated[key] = value;
    }
  }

  return hasChanges ? updated : config;
}

// Helper to escape special regex characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const deleteNodeAtom = atom(null, (get, set, nodeId: string) => {
  const currentNodes = get(nodesAtom);

  // Prevent deletion of trigger nodes
  const nodeToDelete = currentNodes.find((node) => node.id === nodeId);
  if (nodeToDelete?.data.type === "trigger") {
    return;
  }

  // Save current state to history before making changes
  const currentEdges = get(edgesAtom);
  const history = get(historyAtom);
  set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
  set(futureAtom, []);

  const newNodes = currentNodes.filter((node) => node.id !== nodeId);
  const newEdges = currentEdges.filter(
    (edge) => edge.source !== nodeId && edge.target !== nodeId
  );

  set(nodesAtom, newNodes);
  set(edgesAtom, newEdges);

  if (get(selectedNodeAtom) === nodeId) {
    set(selectedNodeAtom, null);
  }

  // Mark as having unsaved changes
  set(hasUnsavedChangesAtom, true);

  // Trigger immediate autosave
  set(autosaveAtom, { immediate: true });
});

export const deleteEdgeAtom = atom(null, (get, set, edgeId: string) => {
  // Save current state to history before making changes
  const currentNodes = get(nodesAtom);
  const currentEdges = get(edgesAtom);
  const history = get(historyAtom);
  set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
  set(futureAtom, []);

  const newEdges = currentEdges.filter((edge) => edge.id !== edgeId);
  set(edgesAtom, newEdges);

  if (get(selectedEdgeAtom) === edgeId) {
    set(selectedEdgeAtom, null);
  }

  // Mark as having unsaved changes
  set(hasUnsavedChangesAtom, true);

  // Trigger immediate autosave
  set(autosaveAtom, { immediate: true });
});

export const deleteSelectedItemsAtom = atom(null, (get, set) => {
  // Save current state to history before making changes
  const currentNodes = get(nodesAtom);
  const currentEdges = get(edgesAtom);
  const history = get(historyAtom);
  set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
  set(futureAtom, []);

  // Get all selected nodes, excluding trigger nodes
  const selectedNodeIds = currentNodes
    .filter((node) => node.selected && node.data.type !== "trigger")
    .map((node) => node.id);

  // Delete selected nodes (excluding trigger nodes) and their connected edges
  const newNodes = currentNodes.filter((node) => {
    // Keep trigger nodes even if selected
    if (node.data.type === "trigger") {
      return true;
    }
    // Remove other selected nodes
    return !node.selected;
  });

  const newEdges = currentEdges.filter(
    (edge) =>
      !(
        edge.selected ||
        selectedNodeIds.includes(edge.source) ||
        selectedNodeIds.includes(edge.target)
      )
  );

  set(nodesAtom, newNodes);
  set(edgesAtom, newEdges);
  set(selectedNodeAtom, null);
  set(selectedEdgeAtom, null);

  // Mark as having unsaved changes
  set(hasUnsavedChangesAtom, true);

  // Trigger immediate autosave
  set(autosaveAtom, { immediate: true });
});

export const clearWorkflowAtom = atom(null, (get, set) => {
  // Save current state to history before making changes
  const currentNodes = get(nodesAtom);
  const currentEdges = get(edgesAtom);
  const history = get(historyAtom);
  set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
  set(futureAtom, []);

  set(nodesAtom, []);
  set(edgesAtom, []);
  set(selectedNodeAtom, null);
  set(selectedEdgeAtom, null);

  // Mark as having unsaved changes
  set(hasUnsavedChangesAtom, true);
});

// Reset all workflow state for org switch (no history push; used by use-organization)
export const resetWorkflowStateForOrgSwitchAtom = atom(null, (_get, set) => {
  set(nodesAtom, []);
  set(edgesAtom, []);
  set(selectedNodeAtom, null);
  set(selectedEdgeAtom, null);
  set(currentWorkflowIdAtom, null);
  set(currentWorkflowNameAtom, "");
  set(currentWorkflowDescriptionAtom, "");
  set(currentWorkflowProjectIdAtom, null);
  set(currentWorkflowTagIdAtom, null);
  set(currentWorkflowVisibilityAtom, "private");
  set(currentWorkflowPublicTagsAtom, []);
  set(isWorkflowOwnerAtom, true);
  set(isWorkflowEnabled, false);
  set(workflowNotFoundAtom, false);
  set(currentExecutionIdAtom, null);
  set(selectedExecutionIdAtom, null);
  set(executionLogsAtom, {});
  set(lastExecutionLogsAtom, { workflowId: null, logs: {} });
  set(hasUnsavedChangesAtom, false);
  set(historyAtom, []);
  set(futureAtom, []);
});

// Load workflow from database
export const loadWorkflowAtom = atom(null, async (get, set) => {
  try {
    set(isLoadingAtom, true);
    const workflow = await api.workflow.getCurrent();
    set(nodesAtom, workflow.nodes);
    set(edgesAtom, workflow.edges);
    if (workflow.id) {
      set(currentWorkflowIdAtom, workflow.id);

      // Pre-fetch last execution logs so template autocomplete has runtime
      // output data available immediately instead of lazy-fetching on first @.
      // Guard: only apply if the workflow hasn't changed by the time data arrives.
      const workflowId = workflow.id;
      api.workflow
        .getExecutions(workflowId)
        .then((executions) => {
          const latest = executions[0];
          if (!latest?.id) {
            return;
          }
          return api.workflow.getExecutionLogs(latest.id);
        })
        .then((logsResponse) => {
          if (!logsResponse) {
            return;
          }
          if (get(currentWorkflowIdAtom) !== workflowId) {
            return;
          }
          const logsByNodeId = buildExecutionLogsMap(logsResponse.logs);
          set(lastExecutionLogsAtom, {
            workflowId,
            logs: logsByNodeId,
          });
        })
        .catch((error: unknown) => {
          console.debug(
            "[loadWorkflow] Pre-fetch execution logs failed:",
            error
          );
        });
    }
  } catch (error) {
    logSystemError(
      ErrorCategory.UNKNOWN,
      "[Workflow] Failed to load workflow",
      error
    );
  } finally {
    set(isLoadingAtom, false);
  }
});

// Save workflow with a name
export const saveWorkflowAsAtom = atom(
  null,
  async (
    get,
    _set,
    { name, description }: { name: string; description?: string }
  ) => {
    const nodes = get(nodesAtom);
    const edges = get(edgesAtom);

    try {
      const workflow = await api.workflow.create({
        name,
        description,
        nodes,
        edges,
      });
      return workflow;
    } catch (error) {
      logSystemError(
        ErrorCategory.UNKNOWN,
        "[Workflow] Failed to save workflow",
        error
      );
      throw error;
    }
  }
);

// Workflow toolbar UI state atoms
export const showClearDialogAtom = atom(false);
export const showDeleteDialogAtom = atom(false);
export const isSavingAtom = atom(false);
export const hasUnsavedChangesAtom = atom(false);
export const workflowNotFoundAtom = atom(false);

// Undo/Redo state
type HistoryState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

const historyAtom = atom<HistoryState[]>([]);
const futureAtom = atom<HistoryState[]>([]);

// Undo atom
export const undoAtom = atom(null, (get, set) => {
  const history = get(historyAtom);
  if (history.length === 0) {
    return;
  }

  const currentNodes = get(nodesAtom);
  const currentEdges = get(edgesAtom);
  const future = get(futureAtom);

  // Save current state to future
  set(futureAtom, [...future, { nodes: currentNodes, edges: currentEdges }]);

  // Pop from history and set as current
  const newHistory = [...history];
  const previousState = newHistory.pop();
  if (!previousState) {
    return; // No history to undo
  }
  set(historyAtom, newHistory);
  set(nodesAtom, previousState.nodes);
  set(edgesAtom, previousState.edges);

  // Mark as having unsaved changes
  set(hasUnsavedChangesAtom, true);
});

// Redo atom
export const redoAtom = atom(null, (get, set) => {
  const future = get(futureAtom);
  if (future.length === 0) {
    return;
  }

  const currentNodes = get(nodesAtom);
  const currentEdges = get(edgesAtom);
  const history = get(historyAtom);

  // Save current state to history
  set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);

  // Pop from future and set as current
  const newFuture = [...future];
  const nextState = newFuture.pop();
  if (!nextState) {
    return; // No future to redo
  }
  set(futureAtom, newFuture);
  set(nodesAtom, nextState.nodes);
  set(edgesAtom, nextState.edges);

  // Mark as having unsaved changes
  set(hasUnsavedChangesAtom, true);
});

// Can undo/redo atoms
export const canUndoAtom = atom((get) => get(historyAtom).length > 0);
export const canRedoAtom = atom((get) => get(futureAtom).length > 0);

// Clear all node statuses (used when clearing runs)
export const clearNodeStatusesAtom = atom(null, (get, set) => {
  const currentNodes = get(nodesAtom);
  const newNodes = currentNodes.map((node) => ({
    ...node,
    data: { ...node.data, status: "idle" as const },
  }));
  set(nodesAtom, newNodes);
});
