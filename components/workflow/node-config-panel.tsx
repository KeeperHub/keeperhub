import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Eraser, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { DeleteWorkflowWithRunsOverlay } from "@/components/overlays/delete-workflow-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ProjectSelect } from "@/components/projects/project-select";
import { TagSelect } from "@/components/tags/tag-select";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { api } from "@/lib/api-client";
import { integrationsAtom } from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
import { VersionHistoryContent } from "./version-history-content";
import {
  clearNodeStatusesAtom,
  clearWorkflowAtom,
  currentWorkflowDescriptionAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  currentWorkflowProjectIdAtom,
  currentWorkflowTagIdAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  isGeneratingAtom,
  isWorkflowOwnerAtom,
  newlyCreatedNodeIdAtom,
  nodesAtom,
  pendingIntegrationNodesAtom,
  propertiesPanelActiveTabAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  showClearDialogAtom,
  showDeleteDialogAtom,
  updateNodeDataAtom,
  workflowNotFoundAtom,
} from "@/lib/workflow/store";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { findActionById } from "@/plugins/registry";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ActionConfig } from "./config/action-config";
import { ActionGrid } from "./config/action-grid";

import { TriggerConfig } from "./config/trigger-config";
import { WorkflowRuns } from "./workflow-runs";

// System actions that need integrations (not in plugin registry)
const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
  "Database Query": "database",
};

// Multi-selection panel component
const MultiSelectionPanel = ({
  selectedNodes,
  selectedEdges,
  onDelete,
}: {
  selectedNodes: { id: string; selected?: boolean }[];
  selectedEdges: { id: string; selected?: boolean }[];
  onDelete: () => void;
}) => {
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);

  const nodeText = selectedNodes.length === 1 ? "node" : "nodes";
  const edgeText = selectedEdges.length === 1 ? "line" : "lines";
  const selectionParts: string[] = [];

  if (selectedNodes.length > 0) {
    selectionParts.push(`${selectedNodes.length} ${nodeText}`);
  }
  if (selectedEdges.length > 0) {
    selectionParts.push(`${selectedEdges.length} ${edgeText}`);
  }

  const selectionText = selectionParts.join(" and ");

  const handleDelete = () => {
    onDelete();
    setShowDeleteAlert(false);
  };

  return (
    <>
      <div className="flex size-full flex-col">
        <div className="flex h-14 w-full shrink-0 items-center border-b bg-transparent px-4">
          <h2 className="font-semibold text-foreground">Properties</h2>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="space-y-2">
            <Label>Selection</Label>
            <p className="text-muted-foreground text-sm">
              {selectionText} selected
            </p>
          </div>

          <div className="flex items-center gap-2 pt-4">
            <Button
              className="text-muted-foreground"
              onClick={() => setShowDeleteAlert(true)}
              size="sm"
              variant="ghost"
            >
              <Trash2 className="mr-2 size-4" />
              Delete
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog onOpenChange={setShowDeleteAlert} open={showDeleteAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Selected Items</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectionText}? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex UI logic with multiple conditions
export const PanelInner = () => {
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const [nodes] = useAtom(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [currentWorkflowName, setCurrentWorkflowName] = useAtom(
    currentWorkflowNameAtom
  );
  const [currentWorkflowDescription, setCurrentWorkflowDescription] = useAtom(
    currentWorkflowDescriptionAtom
  );
  const [currentWorkflowProjectId, setCurrentWorkflowProjectId] = useAtom(
    currentWorkflowProjectIdAtom
  );
  const [currentWorkflowTagId, setCurrentWorkflowTagId] = useAtom(
    currentWorkflowTagIdAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const workflowNotFound = useAtomValue(workflowNotFoundAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
  const [showClearDialog, setShowClearDialog] = useAtom(showClearDialogAtom);
  const [showDeleteDialog, setShowDeleteDialog] = useAtom(showDeleteDialogAtom);
  const clearNodeStatuses = useSetAtom(clearNodeStatusesAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const setPropertiesPanelActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const { open: openOverlay } = useOverlay();

  // Watch showDeleteDialog atom: check for executions first, then open delete overlay or warn and switch to runs
  useEffect(() => {
    if (!showDeleteDialog) {
      return;
    }
    if (!currentWorkflowId) {
      setShowDeleteDialog(false);
      return;
    }

    const openDeleteWorkflowOverlay = () => {
      openOverlay(ConfirmOverlay, {
        title: "Delete Workflow",
        message: `Are you sure you want to delete "${currentWorkflowName}"? This will permanently delete the workflow. This cannot be undone.`,
        confirmLabel: "Delete Workflow",
        confirmVariant: "destructive" as const,
        destructive: true,
        onConfirm: async () => {
          if (!currentWorkflowId) {
            return;
          }
          try {
            await api.workflow.delete(currentWorkflowId);
            toast.success("Workflow deleted successfully");
            window.location.href = "/";
          } catch (error) {
            const msg =
              error instanceof Error
                ? error.message
                : "Failed to delete workflow. Please try again.";
            toast.error(msg);
          }
        },
      });
    };

    const openHasExecutionsOverlay = () => {
      openOverlay(DeleteWorkflowWithRunsOverlay, {
        workflowName: currentWorkflowName,
        onViewRuns: () => {
          setPropertiesPanelActiveTab("runs");
        },
        onForceDelete: async () => {
          if (!currentWorkflowId) {
            return;
          }
          try {
            await api.workflow.delete(currentWorkflowId, { force: true });
            toast.success("Workflow deleted successfully");
            window.location.href = "/";
          } catch (error) {
            const msg =
              error instanceof Error
                ? error.message
                : "Failed to delete workflow. Please try again.";
            toast.error(msg);
          }
        },
      });
    };

    let cancelled = false;
    const handleCheckError = () => {
      if (!cancelled) {
        setShowDeleteDialog(false);
        toast.error("Could not check workflow run history. Please try again.");
      }
    };
    const checkExecutionsAndOpenOverlay = async () => {
      try {
        const executions = await api.workflow.getExecutions(currentWorkflowId);
        if (cancelled) {
          return;
        }
        setShowDeleteDialog(false);
        const executionList = Array.isArray(executions) ? executions : [];
        if (executionList.length > 0) {
          openHasExecutionsOverlay();
          return;
        }
        openDeleteWorkflowOverlay();
      } catch (_e) {
        handleCheckError();
      }
    };
    checkExecutionsAndOpenOverlay();

    return () => {
      cancelled = true;
    };
  }, [
    showDeleteDialog,
    currentWorkflowId,
    currentWorkflowName,
    openOverlay,
    setShowDeleteDialog,
    setPropertiesPanelActiveTab,
  ]);

  // Watch showClearDialog atom and open overlay when it becomes true
  useEffect(() => {
    if (showClearDialog) {
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
      setShowClearDialog(false);
    }
  }, [showClearDialog, openOverlay, clearWorkflow, setShowClearDialog]);
  const setPendingIntegrationNodes = useSetAtom(pendingIntegrationNodesAtom);
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );
  const [showDeleteNodeAlert, setShowDeleteNodeAlert] = useState(false);
  const [showDeleteEdgeAlert, setShowDeleteEdgeAlert] = useState(false);
  const [showDeleteRunsAlert, setShowDeleteRunsAlert] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useAtom(propertiesPanelActiveTabAtom);
  const refreshRunsRef = useRef<(() => Promise<void>) | null>(null);
  const autoSelectAbortControllersRef = useRef<Record<string, AbortController>>(
    {}
  );
  // Tracks in-flight config so multiple synchronous onUpdateConfig calls
  // within the same event (e.g. toggling manual ABI + clearing the field)
  // don't overwrite each other due to stale selectedNode closure.
  const pendingConfigRef = useRef<Record<string, unknown> | null>(null);
  const sidebarRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  // Count multiple selections
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedEdges = edges.filter((edge) => edge.selected);
  const hasMultipleSelections = selectedNodes.length + selectedEdges.length > 1;

  // Switch to Properties tab if Code tab is hidden for the selected node
  useEffect(() => {
    if (!selectedNode || activeTab !== "code") {
      return;
    }

    const isConditionAction =
      selectedNode.data.config?.actionType === "Condition";
    const isManualTrigger =
      selectedNode.data.type === "trigger" &&
      selectedNode.data.config?.triggerType === "Manual";
    const isForEachOrCollect =
      selectedNode.data.config?.actionType === "For Each" ||
      selectedNode.data.config?.actionType === "Collect";

    if (isConditionAction || isManualTrigger || isForEachOrCollect) {
      setActiveTab("properties");
    }
  }, [selectedNode, activeTab, setActiveTab]);

  // Auto-fix invalid integration references when a node is selected
  const globalIntegrations = useAtomValue(integrationsAtom);
  useEffect(() => {
    if (!(selectedNode && isOwner)) {
      return;
    }

    const actionType = selectedNode.data.config?.actionType as
      | string
      | undefined;
    const currentIntegrationId = selectedNode.data.config?.integrationId as
      | string
      | undefined;

    // Skip if no action type or no integration configured
    if (!(actionType && currentIntegrationId)) {
      return;
    }

    // Get the required integration type for this action
    const action = findActionById(actionType);
    const integrationType: IntegrationType | undefined =
      (action?.integration as IntegrationType | undefined) ||
      SYSTEM_ACTION_INTEGRATIONS[actionType];

    if (!integrationType) {
      return;
    }

    // Check if current integration still exists
    const integrationExists = globalIntegrations.some(
      (i) => i.id === currentIntegrationId
    );

    if (integrationExists) {
      return;
    }

    // Current integration was deleted - find a replacement
    const availableIntegrations = globalIntegrations.filter(
      (i) => i.type === integrationType
    );

    if (availableIntegrations.length === 1) {
      // Auto-select the only available integration
      const newConfig = {
        ...selectedNode.data.config,
        integrationId: availableIntegrations[0].id,
      };
      updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
    } else if (availableIntegrations.length === 0) {
      // No integrations available - clear the invalid reference
      const newConfig = {
        ...selectedNode.data.config,
        integrationId: undefined,
      };
      updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
    }
    // If multiple integrations exist, let the user choose manually
  }, [selectedNode, globalIntegrations, isOwner, updateNodeData]);


  const handleDelete = () => {
    if (selectedNodeId) {
      deleteNode(selectedNodeId);
      setShowDeleteNodeAlert(false);
    }
  };

  const handleToggleEnabled = () => {
    if (selectedNode) {
      const currentEnabled = selectedNode.data.enabled ?? true;
      updateNodeData({
        id: selectedNode.id,
        data: { enabled: !currentEnabled },
      });
    }
  };

  const handleDeleteEdge = () => {
    if (selectedEdgeId) {
      deleteEdge(selectedEdgeId);
      setShowDeleteEdgeAlert(false);
    }
  };

  const handleDeleteAllRuns = async () => {
    if (!currentWorkflowId) {
      return;
    }

    try {
      await api.workflow.deleteExecutions(currentWorkflowId);
      clearNodeStatuses();
      setShowDeleteRunsAlert(false);
    } catch (error) {
      console.error("Failed to delete runs:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to delete runs";
      toast.error(errorMessage);
    }
  };

  const handleUpdateLabel = (label: string) => {
    if (selectedNode) {
      updateNodeData({ id: selectedNode.id, data: { label } });
    }
  };

  const handleUpdateDescription = (description: string) => {
    if (selectedNode) {
      updateNodeData({ id: selectedNode.id, data: { description } });
    }
  };
  const autoSelectIntegration = useCallback(
    async (
      nodeId: string,
      actionType: string,
      currentConfig: Record<string, unknown>,
      abortSignal: AbortSignal
    ) => {
      // Get integration type - check plugin registry first, then system actions
      const action = findActionById(actionType);
      const integrationType: IntegrationType | undefined =
        (action?.integration as IntegrationType | undefined) ||
        SYSTEM_ACTION_INTEGRATIONS[actionType];

      if (!integrationType) {
        // No integration needed, remove from pending
        setPendingIntegrationNodes((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        return;
      }

      try {
        const all = await api.integration.getAll();

        // Check if this operation was aborted (actionType changed)
        if (abortSignal.aborted) {
          return;
        }

        const filtered = all.filter((i) => i.type === integrationType);

        // Auto-select if only one integration exists
        if (filtered.length === 1 && !abortSignal.aborted) {
          const newConfig = {
            ...currentConfig,
            actionType,
            integrationId: filtered[0].id,
          };
          updateNodeData({ id: nodeId, data: { config: newConfig } });
        }
      } catch (error) {
        console.error("Failed to auto-select integration:", error);
      } finally {
        // Always remove from pending set when done (unless aborted)
        if (!abortSignal.aborted) {
          setPendingIntegrationNodes((prev: Set<string>) => {
            const next = new Set(prev);
            next.delete(nodeId);
            return next;
          });
        }
      }
    },
    [updateNodeData, setPendingIntegrationNodes]
  );

  // Widened value type to support structured config objects (e.g. conditionConfig)
  // and booleans (e.g. usePrivateMempool for Flashbots routing).
  const handleUpdateConfig = (
    key: string,
    value: string | boolean | Record<string, unknown> | undefined
  ): void => {
    if (selectedNode) {
      const baseConfig = pendingConfigRef.current ?? selectedNode.data.config;
      let newConfig: Record<string, unknown> = { ...baseConfig, [key]: value };

      if (key === "actionType" && typeof value === "string") {
        // Prune leftovers from the previous action type and seed the new
        // action's defaults so showWhen conditions and validation evaluate
        // immediately. See buildConfigForActionTypeChange for details.
        newConfig = buildConfigForActionTypeChange(value, newConfig);
      }

      pendingConfigRef.current = newConfig;
      queueMicrotask(() => {
        pendingConfigRef.current = null;
      });
      updateNodeData({ id: selectedNode.id, data: { config: newConfig } });

      // When action type changes, auto-select integration if only one exists
      if (key === "actionType" && typeof value === "string") {
        // Cancel any pending auto-select operation for this node
        const existingController =
          autoSelectAbortControllersRef.current[selectedNode.id];
        if (existingController) {
          existingController.abort();
        }

        // Create new AbortController for this operation
        const newController = new AbortController();
        autoSelectAbortControllersRef.current[selectedNode.id] = newController;

        // Add to pending set before starting async check
        setPendingIntegrationNodes((prev: Set<string>) =>
          new Set(prev).add(selectedNode.id)
        );
        autoSelectIntegration(
          selectedNode.id,
          value,
          newConfig,
          newController.signal
        );
      }
    }
  };

  const handleUpdateWorkspaceName = async (newName: string) => {
    setCurrentWorkflowName(newName);

    // Save to database if workflow exists
    if (currentWorkflowId) {
      try {
        await api.workflow.update(currentWorkflowId, {
          name: newName,
          nodes,
          edges,
        });
        if (sidebarRefetchTimerRef.current) {
          clearTimeout(sidebarRefetchTimerRef.current);
        }
        sidebarRefetchTimerRef.current = setTimeout(() => {
          refetchSidebar();
        }, 500);
      } catch (error) {
        console.error("Failed to update workflow name:", error);
        toast.error("Failed to update workspace name");
      }
    }
  };

  const handleUpdateWorkflowDescription = async (newDescription: string) => {
    setCurrentWorkflowDescription(newDescription);

    // Save to database if workflow exists
    if (currentWorkflowId) {
      try {
        await api.workflow.update(currentWorkflowId, {
          description: newDescription,
        });
      } catch (error) {
        console.error("Failed to update workflow description:", error);
        toast.error("Failed to update workflow description");
      }
    }
  };

  const handleUpdateWorkflowProject = async (
    newProjectId: string | null
  ): Promise<void> => {
    setCurrentWorkflowProjectId(newProjectId);
    if (currentWorkflowId) {
      try {
        await api.workflow.update(currentWorkflowId, {
          projectId: newProjectId,
        });
        refetchSidebar();
      } catch (error) {
        console.error("Failed to update workflow project:", error);
        toast.error("Failed to update workflow project");
      }
    }
  };

  const handleUpdateWorkflowTag = async (
    newTagId: string | null
  ): Promise<void> => {
    setCurrentWorkflowTagId(newTagId);
    if (currentWorkflowId) {
      try {
        await api.workflow.update(currentWorkflowId, {
          tagId: newTagId,
        });
        refetchSidebar();
      } catch (error) {
        console.error("Failed to update workflow tag:", error);
        toast.error("Failed to update workflow tag");
      }
    }
  };

  const handleRefreshRuns = async () => {
    setIsRefreshing(true);
    try {
      if (refreshRunsRef.current) {
        await refreshRunsRef.current();
      }
    } catch (error) {
      console.error("Failed to refresh runs:", error);
      toast.error("Failed to refresh runs");
    } finally {
      setIsRefreshing(false);
    }
  };

  // If multiple items are selected, show multi-selection properties
  if (hasMultipleSelections) {
    return (
      <MultiSelectionPanel
        onDelete={deleteSelectedItems}
        selectedEdges={selectedEdges}
        selectedNodes={selectedNodes}
      />
    );
  }

  // If an edge is selected, show edge properties
  if (selectedEdge) {
    return (
      <>
        <div className="flex size-full flex-col">
          <div className="flex h-14 w-full shrink-0 items-center border-b bg-transparent px-4">
            <h2 className="font-semibold text-foreground">Properties</h2>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <div className="space-y-2">
              <Label className="ml-1" htmlFor="edge-id">
                Edge ID
              </Label>
              <Input disabled id="edge-id" value={selectedEdge.id} />
            </div>
            <div className="space-y-2">
              <Label className="ml-1" htmlFor="edge-source">
                Source
              </Label>
              <Input disabled id="edge-source" value={selectedEdge.source} />
            </div>
            <div className="space-y-2">
              <Label className="ml-1" htmlFor="edge-target">
                Target
              </Label>
              <Input disabled id="edge-target" value={selectedEdge.target} />
            </div>

            {isOwner && (
              <div className="flex items-center gap-2 pt-4">
                <Button
                  className="text-muted-foreground"
                  onClick={() => setShowDeleteEdgeAlert(true)}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </Button>
              </div>
            )}
          </div>
        </div>

        <AlertDialog
          onOpenChange={setShowDeleteEdgeAlert}
          open={showDeleteEdgeAlert}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Edge</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this connection? This action
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDeleteEdge}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  // If no node is selected, show workspace properties and runs
  if (!selectedNode) {
    return (
      <>
        <Tabs
          className="size-full"
          defaultValue="properties"
          onValueChange={setActiveTab}
          value={
            activeTab === "properties" ||
            ((activeTab === "runs" || activeTab === "history") && isOwner)
              ? activeTab
              : "properties"
          }
        >
          <TabsList className="h-14 w-full shrink-0 rounded-none border-b bg-transparent px-4 py-2.5">
            <TabsTrigger
              className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
              value="properties"
            >
              Properties
            </TabsTrigger>
            {isOwner && (
              <TabsTrigger
                className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
                value="runs"
              >
                Runs
              </TabsTrigger>
            )}
            {isOwner && (
              <TabsTrigger
                className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
                value="history"
              >
                History
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent
            className="flex flex-col overflow-hidden"
            value="properties"
          >
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="workflow-name">
                  Workflow Name
                </Label>
                <Input
                  disabled={!isOwner}
                  id="workflow-name"
                  onChange={(e) => handleUpdateWorkspaceName(e.target.value)}
                  value={currentWorkflowName}
                />
              </div>
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="workflow-description">
                  Description
                </Label>
                <Textarea
                  disabled={!isOwner}
                  id="workflow-description"
                  onChange={(e) =>
                    handleUpdateWorkflowDescription(e.target.value)
                  }
                  placeholder="Optional workflow description"
                  rows={3}
                  value={currentWorkflowDescription}
                />
              </div>
              <div className="space-y-2">
                <Label className="ml-1">Project</Label>
                <ProjectSelect
                  disabled={!isOwner}
                  onChange={handleUpdateWorkflowProject}
                  value={currentWorkflowProjectId}
                />
              </div>
              <div className="space-y-2">
                <Label className="ml-1">Tag</Label>
                <p className="ml-1 text-muted-foreground text-xs">
                  Add a tag to organise your workflow within your project.
                </p>
                <TagSelect
                  disabled={!isOwner}
                  onChange={handleUpdateWorkflowTag}
                  value={currentWorkflowTagId}
                />
              </div>
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="workflow-id">
                  Workflow ID
                </Label>
                <Input
                  disabled
                  id="workflow-id"
                  value={currentWorkflowId || "Not saved"}
                />
              </div>
              {!isOwner && (
                <div className="rounded-lg border border-muted bg-muted/30 p-3">
                  <p className="text-muted-foreground text-sm">
                    You're viewing this workflow in read-only mode.
                    Use it as a template to create your own editable copy.
                  </p>
                </div>
              )}
              {isOwner && (
                <div className="flex items-center gap-2 pt-4">
                  <Button
                    className="text-muted-foreground"
                    disabled={workflowNotFound}
                    onClick={() => setShowClearDialog(true)}
                    size="sm"
                    variant="ghost"
                  >
                    <Eraser className="mr-2 size-4" />
                    Clear
                  </Button>
                  <Button
                    className="text-muted-foreground"
                    disabled={workflowNotFound}
                    onClick={() => {
                      setShowDeleteDialog(true);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2 className="mr-2 size-4" />
                    Delete
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
          {isOwner && (
            <TabsContent className="flex flex-col overflow-hidden" value="runs">
              {/* Actions in content header */}
              <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
                <Button
                  className="text-muted-foreground"
                  disabled={isRefreshing}
                  onClick={handleRefreshRuns}
                  size="sm"
                  variant="ghost"
                >
                  <RefreshCw
                    className={`mr-2 size-4 ${isRefreshing ? "animate-spin" : ""}`}
                  />
                  Refresh
                </Button>
                <Button
                  className="text-muted-foreground"
                  disabled={workflowNotFound}
                  onClick={() => setShowDeleteRunsAlert(true)}
                  size="sm"
                  variant="ghost"
                >
                  <Eraser className="mr-2 size-4" />
                  Clear All
                </Button>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto p-4">
                <WorkflowRuns
                  isActive={activeTab === "runs"}
                  onRefreshRef={refreshRunsRef}
                />
              </div>
            </TabsContent>
          )}
          {isOwner && (
            <TabsContent
              className="flex flex-col overflow-y-auto p-3"
              value="history"
            >
              <VersionHistoryContent active={activeTab === "history"} />
            </TabsContent>
          )}
        </Tabs>

        <AlertDialog
          onOpenChange={setShowDeleteRunsAlert}
          open={showDeleteRunsAlert}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete All Runs</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete all workflow runs? This action
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDeleteAllRuns}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <>
      <Tabs
        className="size-full"
        data-testid="properties-panel"
        defaultValue="properties"
        onValueChange={setActiveTab}
        value={
          activeTab === "properties" ||
          ((activeTab === "runs" || activeTab === "history") && isOwner)
            ? activeTab
            : "properties"
        }
      >
        <TabsList className="h-14 w-full shrink-0 rounded-none border-b bg-transparent px-4 py-2.5">
          <TabsTrigger
            className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
            value="properties"
          >
            Properties
          </TabsTrigger>
          {isOwner && (
            <TabsTrigger
              className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
              value="runs"
            >
              Runs
            </TabsTrigger>
          )}
          {isOwner && (
            <TabsTrigger
              className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
              value="history"
            >
              History
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent
          className="flex flex-col overflow-hidden"
          value="properties"
        >
          {/* Action selection - full height flex layout */}
          {selectedNode.data.type === "action" &&
            !selectedNode.data.config?.actionType &&
            isOwner && (
              <div className="flex min-h-0 flex-1 flex-col px-4 pt-4">
                <ActionGrid
                  disabled={isGenerating}
                  isNewlyCreated={selectedNode?.id === newlyCreatedNodeId}
                  onSelectAction={(actionType) => {
                    handleUpdateConfig("actionType", actionType);
                    // Clear newly created tracking once action is selected
                    if (selectedNode?.id === newlyCreatedNodeId) {
                      setNewlyCreatedNodeId(null);
                    }
                  }}
                />
              </div>
            )}

          {/* Other content - scrollable */}
          {!(
            selectedNode.data.type === "action" &&
            !selectedNode.data.config?.actionType &&
            isOwner
          ) && (
            // key forces this subtree to remount when the selected node
            // changes, resetting local useState in leaf field components so
            // the previous node's inputs don't leak into the new node's panel.
            <div
              className="flex-1 space-y-4 overflow-y-auto p-4"
              key={selectedNode.id}
            >
              {selectedNode.data.type === "trigger" && (
                <TriggerConfig
                  config={selectedNode.data.config || {}}
                  disabled={isGenerating || !isOwner}
                  onUpdateConfig={handleUpdateConfig}
                  workflowId={currentWorkflowId ?? undefined}
                />
              )}

              {selectedNode.data.type === "action" &&
                !selectedNode.data.config?.actionType &&
                !isOwner && (
                  <div className="rounded-lg border border-muted bg-muted/30 p-3">
                    <p className="text-muted-foreground text-sm">
                      No action configured for this step.
                    </p>
                  </div>
                )}

              {selectedNode.data.type === "action" &&
              selectedNode.data.config?.actionType ? (
                <ActionConfig
                  config={selectedNode.data.config || {}}
                  disabled={isGenerating || !isOwner}
                  isOwner={isOwner}
                  nodeId={selectedNode.id}
                  onUpdateConfig={handleUpdateConfig}
                />
              ) : null}

              {selectedNode.data.type !== "action" ||
              selectedNode.data.config?.actionType ? (
                <>
                  <div className="space-y-2">
                    <Label className="ml-1" htmlFor="label">
                      Label
                    </Label>
                    <Input
                      disabled={isGenerating || !isOwner}
                      id="label"
                      onChange={(e) => handleUpdateLabel(e.target.value)}
                      value={selectedNode.data.label}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="ml-1" htmlFor="description">
                      Description
                    </Label>
                    <Textarea
                      className="max-h-64 resize-y bg-transparent dark:bg-transparent"
                      disabled={isGenerating || !isOwner}
                      id="description"
                      onChange={(e) => handleUpdateDescription(e.target.value)}
                      placeholder="Optional description"
                      rows={3}
                      value={selectedNode.data.description || ""}
                    />
                  </div>
                </>
              ) : null}

              {!isOwner && (
                <div className="rounded-lg border border-muted bg-muted/30 p-3">
                  <p className="text-muted-foreground text-sm">
                    You're viewing this workflow in read-only mode.
                    Use it as a template to create your own editable copy.
                  </p>
                </div>
              )}

              {/* Actions and integration selector */}
              {isOwner && (
                <div className="flex items-center justify-between gap-2 pt-4">
                  <div className="flex items-center gap-2">
                    {selectedNode.data.type === "action" && (
                      <Button
                        className="text-muted-foreground"
                        onClick={handleToggleEnabled}
                        size="sm"
                        variant="ghost"
                      >
                        {selectedNode.data.enabled === false ? (
                          <>
                            <EyeOff className="mr-2 size-4" />
                            Disabled
                          </>
                        ) : (
                          <>
                            <Eye className="mr-2 size-4" />
                            Enabled
                          </>
                        )}
                      </Button>
                    )}
                    {selectedNode.data.type !== "trigger" && (
                      <Button
                        className="text-muted-foreground"
                        onClick={() => setShowDeleteNodeAlert(true)}
                        size="sm"
                        variant="ghost"
                      >
                        <Trash2 className="mr-2 size-4" />
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>
        {isOwner && (
          <TabsContent
            className="flex flex-col overflow-y-auto p-3"
            value="history"
          >
            <VersionHistoryContent
              active={activeTab === "history"}
              nodeId={selectedNode.id}
              nodeLabel={(selectedNode.data.label as string) ?? null}
            />
          </TabsContent>
        )}
        {isOwner && (
          <TabsContent className="flex flex-col overflow-hidden" value="runs">
            {/* Actions in content header */}
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
              <Button
                className="text-muted-foreground"
                disabled={isRefreshing}
                onClick={handleRefreshRuns}
                size="sm"
                variant="ghost"
              >
                <RefreshCw
                  className={`mr-2 size-4 ${isRefreshing ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
              <Button
                className="text-muted-foreground"
                onClick={() => setShowDeleteRunsAlert(true)}
                size="sm"
                variant="ghost"
              >
                <Eraser className="mr-2 size-4" />
                Clear All
              </Button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <WorkflowRuns
                isActive={activeTab === "runs"}
                onRefreshRef={refreshRunsRef}
              />
            </div>
          </TabsContent>
        )}
      </Tabs>

      <AlertDialog
        onOpenChange={setShowDeleteRunsAlert}
        open={showDeleteRunsAlert}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete All Runs</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete all workflow runs? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAllRuns}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        onOpenChange={setShowDeleteNodeAlert}
        open={showDeleteNodeAlert}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Step</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this node? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
export const NodeConfigPanel = () => (
  <div className="hidden size-full flex-col bg-background md:flex">
    <PanelInner />
  </div>
);
