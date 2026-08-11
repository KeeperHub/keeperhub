"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Eraser,
  Eye,
  EyeOff,
  History,
  Play,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { SmartOverlayHeader } from "@/components/overlays/overlay-header";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api-client";
import { integrationsAtom } from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
import {
  clearNodeStatusesAtom,
  clearWorkflowAtom,
  currentWorkflowDescriptionAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  edgesAtom,
  isGeneratingAtom,
  isWorkflowOwnerAtom,
  newlyCreatedNodeIdAtom,
  nodesAtom,
  propertiesPanelActiveTabAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
} from "@/lib/workflow/store";
import { findActionById } from "@/plugins/registry";
import { ActionConfig } from "../workflow/config/action-config";
import { ActionGrid } from "../workflow/config/action-grid";
import { TriggerConfig } from "../workflow/config/trigger-config";
import { VersionHistoryContent } from "../workflow/version-history-content";
import { WorkflowRuns } from "../workflow/workflow-runs";
import type { OverlayComponentProps } from "./types";

// System actions that need integrations (not in plugin registry)
const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
  "Database Query": "database",
};


type ConfigurationOverlayProps = OverlayComponentProps;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex UI logic with multiple conditions
export function ConfigurationOverlay({ overlayId }: ConfigurationOverlayProps) {
  const { push, closeAll } = useOverlay();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [currentWorkflowName, setCurrentWorkflowName] = useAtom(
    currentWorkflowNameAtom
  );
  const [currentWorkflowDescription, setCurrentWorkflowDescription] = useAtom(
    currentWorkflowDescriptionAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);

  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const clearNodeStatuses = useSetAtom(clearNodeStatusesAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );
  const [activeTab, setActiveTab] = useAtom(propertiesPanelActiveTabAtom);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshRunsRef = useRef<(() => Promise<void>) | null>(null);
  const pendingConfigRef = useRef<Record<string, unknown> | null>(null);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  // Auto-fix invalid integration references
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

    if (!(actionType && currentIntegrationId)) {
      return;
    }

    const action = findActionById(actionType);
    const integrationType: IntegrationType | undefined =
      (action?.integration as IntegrationType | undefined) ||
      SYSTEM_ACTION_INTEGRATIONS[actionType];

    if (!integrationType) {
      return;
    }

    const validIntegrations = globalIntegrations.filter(
      (i) => i.type === integrationType
    );
    const isValid = validIntegrations.some(
      (i) => i.id === currentIntegrationId
    );

    if (!isValid && validIntegrations.length > 0) {
      updateNodeData({
        id: selectedNode.id,
        data: {
          config: {
            ...selectedNode.data.config,
            integrationId: validIntegrations[0].id,
          },
        },
      });
    }
  }, [selectedNode, globalIntegrations, isOwner, updateNodeData]);

  const handleUpdateConfig = useCallback(
    (
      key: string,
      value: string | boolean | Record<string, unknown> | undefined
    ): void => {
      if (!selectedNode) {
        return;
      }
      // KEEP-137: some fields (e.g., ChainSelectField with showPrivateVariants)
      // fire two synchronous handleUpdateConfig calls. Without pendingConfigRef,
      // both spread the same stale selectedNode.data.config snapshot and the
      // second call wipes out the first. The ref batches back-to-back updates
      // within a microtask so the second call sees the first's merged config.
      const baseConfig =
        pendingConfigRef.current ?? selectedNode.data.config ?? {};
      const newConfig = { ...baseConfig, [key]: value };
      pendingConfigRef.current = newConfig;
      queueMicrotask(() => {
        pendingConfigRef.current = null;
      });
      updateNodeData({
        id: selectedNode.id,
        data: { config: newConfig },
      });
    },
    [selectedNode, updateNodeData]
  );

  const handleUpdateLabel = useCallback(
    (label: string) => {
      if (!selectedNode) {
        return;
      }
      updateNodeData({ id: selectedNode.id, data: { label } });
    },
    [selectedNode, updateNodeData]
  );

  const handleUpdateDescription = useCallback(
    (description: string) => {
      if (!selectedNode) {
        return;
      }
      updateNodeData({ id: selectedNode.id, data: { description } });
    },
    [selectedNode, updateNodeData]
  );

  const handleToggleEnabled = useCallback(() => {
    if (!selectedNode) {
      return;
    }
    updateNodeData({
      id: selectedNode.id,
      data: { enabled: selectedNode.data.enabled === false },
    });
  }, [selectedNode, updateNodeData]);

  const handleDeleteNode = useCallback(() => {
    push(ConfirmOverlay, {
      title: "Delete Step",
      message:
        "Are you sure you want to delete this node? This action cannot be undone.",
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      onConfirm: () => {
        if (selectedNode) {
          deleteNode(selectedNode.id);
          closeAll();
        }
      },
    });
  }, [selectedNode, deleteNode, closeAll, push]);

  const handleRefreshRuns = async () => {
    if (refreshRunsRef.current) {
      setIsRefreshing(true);
      await refreshRunsRef.current();
      setIsRefreshing(false);
    }
  };

  const handleDeleteAllRuns = () => {
    push(ConfirmOverlay, {
      title: "Delete All Runs",
      message:
        "Are you sure you want to delete all workflow runs? This action cannot be undone.",
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      onConfirm: async () => {
        if (!currentWorkflowId) {
          return;
        }
        try {
          await api.workflow.deleteExecutions(currentWorkflowId);
          clearNodeStatuses();
          if (refreshRunsRef.current) {
            await refreshRunsRef.current();
          }
          toast.success("All runs deleted");
        } catch (error) {
          console.error("Failed to delete runs:", error);
          toast.error("Failed to delete runs");
        }
      },
    });
  };

  // Get current tab title
  const getTabTitle = () => {
    if (!selectedNode) {
      // For workflow view, validate the tab
      const validTab =
        activeTab === "properties" ||
        ((activeTab === "runs" || activeTab === "history") && isOwner)
          ? activeTab
          : "properties";
      switch (validTab) {
        case "properties":
          return "Workflow";
        case "runs":
          return "Runs";
        case "history":
          return "History";
        default:
          return "Workflow";
      }
    }
    switch (activeTab) {
      case "properties":
        return "Properties";
      case "runs":
        return "Runs";
      case "history":
        return "History";
      default:
        return "Properties";
    }
  };

  // Handle updating workflow name
  const handleUpdateWorkflowName = async (newName: string) => {
    setCurrentWorkflowName(newName);

    if (currentWorkflowId) {
      try {
        await api.workflow.update(currentWorkflowId, { name: newName });
      } catch (error) {
        console.error("Failed to update workflow name:", error);
      }
    }
  };

  // Handle updating workflow description
  const handleUpdateWorkflowDescription = async (newDescription: string) => {
    setCurrentWorkflowDescription(newDescription);

    if (currentWorkflowId) {
      try {
        await api.workflow.update(currentWorkflowId, {
          description: newDescription,
        });
      } catch (error) {
        console.error("Failed to update workflow description:", error);
      }
    }
  };

  // Handle clear workflow
  const handleClearWorkflow = () => {
    push(ConfirmOverlay, {
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

  // Handle delete workflow
  const handleDeleteWorkflow = (force?: boolean) => {
    const title = force ? "Delete Workflow and All Runs" : "Delete Workflow";
    const message = force
      ? `Are you sure you want to delete "${currentWorkflowName}" and all its execution history? This cannot be undone.`
      : `Are you sure you want to delete "${currentWorkflowName}"? This will permanently delete the workflow. This cannot be undone.`;
    const confirmLabel = force ? "Delete Everything" : "Delete Workflow";

    push(ConfirmOverlay, {
      title,
      message,
      confirmLabel,
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: async () => {
        if (!currentWorkflowId) {
          return;
        }
        try {
          await api.workflow.delete(currentWorkflowId, { force });
          closeAll();
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


  // Handle delete edge
  const handleDeleteEdge = () => {
    if (selectedEdgeId) {
      push(ConfirmOverlay, {
        title: "Delete Connection",
        message:
          "Are you sure you want to delete this connection? This action cannot be undone.",
        confirmLabel: "Delete",
        confirmVariant: "destructive" as const,
        onConfirm: () => {
          deleteEdge(selectedEdgeId);
          closeAll();
        },
      });
    }
  };

  // If an edge is selected, show edge properties
  if (selectedEdge && !selectedNode) {
    return (
      <div className="flex h-full max-h-[80vh] flex-col">
        <SmartOverlayHeader overlayId={overlayId} title="Connection" />

        <div className="flex-1 space-y-4 overflow-y-auto px-6 pt-4 pb-6">
          <div className="space-y-2">
            <Label htmlFor="edge-id">Connection ID</Label>
            <Input disabled id="edge-id" value={selectedEdge.id} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edge-source">Source</Label>
            <Input disabled id="edge-source" value={selectedEdge.source} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edge-target">Target</Label>
            <Input disabled id="edge-target" value={selectedEdge.target} />
          </div>
          {isOwner && (
            <div className="pt-2">
              <Button onClick={handleDeleteEdge} variant="ghost">
                <Trash2 className="mr-2 size-4" />
                Delete Connection
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // If no node is selected, show workflow-level configuration
  if (!selectedNode) {
    // For workflow view, properties plus runs/history (if owner) are valid tabs.
    const validWorkflowTab =
      activeTab === "properties" ||
      ((activeTab === "runs" || activeTab === "history") && isOwner)
        ? activeTab
        : "properties";

    return (
      <div className="flex h-full max-h-[80vh] flex-col">
        <SmartOverlayHeader overlayId={overlayId} title={getTabTitle()} />

        <div className="flex-1 overflow-y-auto">
          {validWorkflowTab === "properties" && (
            <div className="space-y-4 px-6 pt-4 pb-6">
              <div className="space-y-2">
                <Label htmlFor="workflow-name">Workflow Name</Label>
                <Input
                  disabled={!isOwner}
                  id="workflow-name"
                  onChange={(e) => handleUpdateWorkflowName(e.target.value)}
                  value={currentWorkflowName}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="workflow-id">Workflow ID</Label>
                <Input
                  disabled
                  id="workflow-id"
                  value={currentWorkflowId || "Not saved"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="workflow-description">Description</Label>
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
              {!isOwner && (
                <div className="rounded-lg border border-muted bg-muted/30 p-3">
                  <p className="text-muted-foreground text-sm">
                    You're viewing this workflow in read-only mode.
                    Use it as a template to create your own editable copy.
                  </p>
                </div>
              )}
              {isOwner ? (
                <div className="flex items-center gap-2 pt-2">
                  <Button onClick={handleClearWorkflow} variant="ghost">
                    <Eraser className="mr-2 size-4" />
                    Clear
                  </Button>
                  <Button
                    data-testid="delete-workflow-button"
                    onClick={() => handleDeleteWorkflow()}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="mr-2 size-4" />
                    Delete
                  </Button>
                </div>
              ) : (
                <div className="text-red-500 text-xs">
                  DEBUG: isOwner is false - Delete button not rendered
                </div>
              )}
            </div>
          )}

          {validWorkflowTab === "history" && isOwner && (
            <div className="px-3 py-3">
              <VersionHistoryContent active={validWorkflowTab === "history"} />
            </div>
          )}

          {validWorkflowTab === "runs" && isOwner && (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
                <Button
                  className="text-muted-foreground"
                  disabled={isRefreshing}
                  onClick={handleRefreshRuns}
                  size="icon"
                  variant="ghost"
                >
                  <RefreshCw
                    className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
                  />
                </Button>
                <Button
                  className="text-muted-foreground"
                  onClick={handleDeleteAllRuns}
                  size="icon"
                  variant="ghost"
                >
                  <Eraser className="size-4" />
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <WorkflowRuns
                  isActive={validWorkflowTab === "runs"}
                  onRefreshRef={refreshRunsRef}
                />
              </div>
            </div>
          )}
        </div>

        {/* Bottom tab navigation */}
        <div className="flex shrink-0 items-center justify-around border-t bg-background pb-safe">
          <button
            className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
              validWorkflowTab === "properties"
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveTab("properties")}
            type="button"
          >
            <Settings2 className="size-5" />
            Workflow
          </button>
          {isOwner && (
            <button
              className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
                validWorkflowTab === "runs"
                  ? "text-foreground"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("runs")}
              type="button"
            >
              <Play className="size-5" />
              Runs
            </button>
          )}
          {isOwner && (
            <button
              className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
                validWorkflowTab === "history"
                  ? "text-foreground"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("history")}
              type="button"
            >
              <History className="size-5" />
              History
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full max-h-[80vh] flex-col">
      {/* Header with current tab name */}
      <SmartOverlayHeader overlayId={overlayId} title={getTabTitle()} />

      {/* Content based on active tab. */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "properties" && (
          <div className="space-y-4 px-6 pt-4 pb-6">
            {/* Action selection */}
            {selectedNode.data.type === "action" &&
              !selectedNode.data.config?.actionType &&
              isOwner && (
                <ActionGrid
                  disabled={isGenerating}
                  isNewlyCreated={selectedNode?.id === newlyCreatedNodeId}
                  onSelectAction={(actionType) => {
                    handleUpdateConfig("actionType", actionType);
                    if (selectedNode?.id === newlyCreatedNodeId) {
                      setNewlyCreatedNodeId(null);
                    }
                  }}
                />
              )}

            {selectedNode.data.type === "trigger" && (
              <TriggerConfig
                config={selectedNode.data.config || {}}
                disabled={isGenerating || !isOwner}
                onUpdateConfig={handleUpdateConfig}
                workflowId={currentWorkflowId ?? undefined}
              />
            )}

            {selectedNode.data.type === "action" &&
              selectedNode.data.config?.actionType !== undefined && (
                <ActionConfig
                  config={selectedNode.data.config || {}}
                  disabled={isGenerating || !isOwner}
                  isOwner={isOwner}
                  nodeId={selectedNode.id}
                  onUpdateConfig={handleUpdateConfig}
                />
              )}

            {/* Label & Description */}
            {(selectedNode.data.type !== "action" ||
              selectedNode.data.config?.actionType !== undefined) && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="label">Label</Label>
                  <Input
                    disabled={isGenerating || !isOwner}
                    id="label"
                    onChange={(e) => handleUpdateLabel(e.target.value)}
                    value={selectedNode.data.label as string}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    className="max-h-64 resize-y bg-transparent dark:bg-transparent"
                    disabled={isGenerating || !isOwner}
                    id="description"
                    onChange={(e) => handleUpdateDescription(e.target.value)}
                    placeholder="Optional description"
                    rows={3}
                    value={(selectedNode.data.description as string) || ""}
                  />
                </div>
              </>
            )}

            {/* Actions */}
            {isOwner && (
              <div className="flex items-center gap-2 pt-2">
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
                <Button
                  className="text-muted-foreground"
                  onClick={handleDeleteNode}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </Button>
              </div>
            )}
          </div>
        )}

        {activeTab === "history" && isOwner && (
          <div className="px-3 py-3">
            <VersionHistoryContent
              active={activeTab === "history"}
              nodeId={selectedNode.id}
              nodeLabel={(selectedNode.data.label as string) ?? null}
            />
          </div>
        )}

        {activeTab === "runs" && isOwner && (
          <div className="flex h-full flex-col">
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
                onClick={handleDeleteAllRuns}
                size="sm"
                variant="ghost"
              >
                <Eraser className="mr-2 size-4" />
                Clear All
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <WorkflowRuns
                isActive={activeTab === "runs"}
                onRefreshRef={refreshRunsRef}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom tab navigation */}
      <div className="flex shrink-0 items-center justify-around border-t bg-background pb-safe">
        <button
          className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
            activeTab === "properties"
              ? "text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={() => setActiveTab("properties")}
          type="button"
        >
          <Settings2 className="size-5" />
          Properties
        </button>
        {isOwner && (
          <button
            className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
              activeTab === "runs" ? "text-foreground" : "text-muted-foreground"
            }`}
            onClick={() => setActiveTab("runs")}
            type="button"
          >
            <Play className="size-5" />
            Runs
          </button>
        )}
        {isOwner && (
          <button
            className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
              activeTab === "history"
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveTab("history")}
            type="button"
          >
            <History className="size-5" />
            History
          </button>
        )}
      </div>
    </div>
  );
}
