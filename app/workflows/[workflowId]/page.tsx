"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, ChevronRight, Globe, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NodeConfigPanel } from "@/components/workflow/node-config-panel";
import { useGatedWorkflowWarning } from "@/hooks/use-features";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import {
  getPendingClaim,
  useClaimWorkflow,
} from "@/lib/hooks/use-claim-workflow";
import {
  integrationsAtom,
  integrationsLoadedAtom,
  integrationsVersionAtom,
} from "@/lib/integrations-store";
import type { IntegrationType } from "@/lib/types/integration";
import {
  currentExecutionIdAtom,
  currentWorkflowDescriptionAtom,
  currentWorkflowIdAtom,
  currentWorkflowInputSchemaAtom,
  currentWorkflowIsListedAtom,
  currentWorkflowListedAtAtom,
  currentWorkflowListedSlugAtom,
  currentWorkflowNameAtom,
  currentWorkflowOutputMappingAtom,
  currentWorkflowPriceUsdcAtom,
  currentWorkflowProjectIdAtom,
  currentWorkflowPublicTagsAtom,
  currentWorkflowShareExecutionStatusAtom,
  currentWorkflowTagIdAtom,
  currentWorkflowVisibilityAtom,
  edgesAtom,
  hasSidebarBeenShownAtom,
  hasUnsavedChangesAtom,
  isExecutingAtom,
  isGeneratingAtom,
  isPanelAnimatingAtom,
  isSavingAtom,
  isSidebarCollapsedAtom,
  isWorkflowEnabled,
  isWorkflowOwnerAtom,
  newlyCreatedNodeIdAtom,
  nodesAtom,
  previewVersionAtom,
  propertiesPanelActiveTabAtom,
  rightPanelWidthAtom,
  rightPanelWidthPctAtom,
  selectedExecutionIdAtom,
  selectedNodeAtom,
  triggerExecuteAtom,
  updateNodeDataAtom,
  type WorkflowNode,
  type WorkflowVisibility,
  workflowNotFoundAtom,
} from "@/lib/workflow/store";
import { useVersionPreview } from "@/lib/workflow/use-version-preview";
import { findActionById } from "@/plugins/registry";

type WorkflowPageProps = {
  params: Promise<{ workflowId: string }>;
};

type WorkflowEditorProps = {
  workflowId: string;
};

// System actions that need integrations (not in plugin registry)
const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
  "Database Query": "database",
};

// Helper to get required integration type for an action
function getRequiredIntegrationType(
  actionType: string
): IntegrationType | undefined {
  const action = findActionById(actionType);
  return (
    (action?.integration as IntegrationType | undefined) ||
    SYSTEM_ACTION_INTEGRATIONS[actionType]
  );
}

// Helper to check and fix a single node's integration
type IntegrationFixResult = {
  nodeId: string;
  newIntegrationId: string | undefined;
};

function checkNodeIntegration(
  node: WorkflowNode,
  allIntegrations: { id: string; type: string }[],
  validIntegrationIds: Set<string>
): IntegrationFixResult | null {
  const actionType = node.data.config?.actionType as string | undefined;
  if (!actionType) {
    return null;
  }

  const integrationType = getRequiredIntegrationType(actionType);
  if (!integrationType) {
    return null;
  }

  const currentIntegrationId = node.data.config?.integrationId as
    | string
    | undefined;
  const hasValidIntegration =
    currentIntegrationId && validIntegrationIds.has(currentIntegrationId);

  if (hasValidIntegration) {
    return null;
  }

  // Find available integrations of this type
  const available = allIntegrations.filter((i) => i.type === integrationType);

  if (available.length === 1) {
    return { nodeId: node.id, newIntegrationId: available[0].id };
  }
  if (available.length === 0 && currentIntegrationId) {
    return { nodeId: node.id, newIntegrationId: undefined };
  }
  return null;
}

const WorkflowEditor = ({ workflowId }: WorkflowEditorProps) => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const isMobile = useIsMobile();
  const [isGenerating, setIsGenerating] = useAtom(isGeneratingAtom);
  const [_isSaving, setIsSaving] = useAtom(isSavingAtom);
  const [nodes] = useAtom(nodesAtom);

  // Check if workflow has a trigger node - panels only show when trigger exists
  const hasTriggerNode = useMemo(
    () => nodes.some((node) => node.data.type === "trigger"),
    [nodes]
  );

  const [edges] = useAtom(edgesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const workflowActionTypes = useMemo(
    () =>
      nodes
        .filter((node) => node.data.type === "action")
        .map((node) => {
          const cfg = node.data.config;
          const value =
            cfg && typeof cfg === "object" && "actionType" in cfg
              ? (cfg as { actionType?: unknown }).actionType
              : undefined;
          return typeof value === "string" ? value : "";
        })
        .filter((s) => s.length > 0),
    [nodes]
  );
  useGatedWorkflowWarning(
    currentWorkflowId === workflowId ? workflowId : null,
    workflowActionTypes
  );
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const [isExecuting, setIsExecuting] = useAtom(isExecutingAtom);
  const setCurrentExecutionId = useSetAtom(currentExecutionIdAtom);
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setPreviewVersion = useSetAtom(previewVersionAtom);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const setCurrentWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const setCurrentWorkflowDescription = useSetAtom(
    currentWorkflowDescriptionAtom
  );
  const setCurrentWorkflowProjectId = useSetAtom(currentWorkflowProjectIdAtom);
  const setCurrentWorkflowTagId = useSetAtom(currentWorkflowTagIdAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const [workflowNotFound, setWorkflowNotFound] = useAtom(workflowNotFoundAtom);
  const setTriggerExecute = useSetAtom(triggerExecuteAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const setIsPanelAnimating = useSetAtom(isPanelAnimatingAtom);
  const [hasSidebarBeenShown, setHasSidebarBeenShown] = useAtom(
    hasSidebarBeenShownAtom
  );
  const [panelCollapsed, setPanelCollapsed] = useAtom(isSidebarCollapsedAtom);
  const setCurrentWorkflowVisibility = useSetAtom(
    currentWorkflowVisibilityAtom
  );
  const [isOwner, setIsWorkflowOwner] = useAtom(isWorkflowOwnerAtom);
  const setIsWorkflowEnabled = useSetAtom(isWorkflowEnabled); // keeperhub custom field //
  const setCurrentWorkflowPublicTags = useSetAtom(
    currentWorkflowPublicTagsAtom
  );
  const setCurrentWorkflowIsListed = useSetAtom(currentWorkflowIsListedAtom);
  const setCurrentWorkflowListedSlug = useSetAtom(
    currentWorkflowListedSlugAtom
  );
  const setCurrentWorkflowListedAt = useSetAtom(currentWorkflowListedAtAtom);
  const setCurrentWorkflowInputSchema = useSetAtom(
    currentWorkflowInputSchemaAtom
  );
  const setCurrentWorkflowOutputMapping = useSetAtom(
    currentWorkflowOutputMappingAtom
  );
  const setCurrentWorkflowPriceUsdc = useSetAtom(currentWorkflowPriceUsdcAtom);
  const setCurrentWorkflowShareExecutionStatus = useSetAtom(
    currentWorkflowShareExecutionStatusAtom
  );
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setNewlyCreatedNodeId = useSetAtom(newlyCreatedNodeIdAtom);
  const setGlobalIntegrations = useSetAtom(integrationsAtom);
  const setIntegrationsLoaded = useSetAtom(integrationsLoadedAtom);
  const integrationsVersion = useAtomValue(integrationsVersionAtom);
  const { data: session } = useSession();

  // Helper to create anonymous session if needed
  const ensureSession = useCallback(async () => {
    if (!session) {
      await authClient.signIn.anonymous();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, [session]);

  // Panel width (viewport %), shared with the version-history panel so the
  // two right-docked panels stay the same size and resizing keeps them in sync.
  const [panelWidth, setPanelWidth] = useAtom(rightPanelWidthPctAtom);
  // Start visible if sidebar has already been shown (switching between workflows)
  const [panelVisible, setPanelVisible] = useState(hasSidebarBeenShown);
  const [isDraggingResize, setIsDraggingResize] = useState(false);
  const isResizing = useRef(false);
  const hasReadCookies = useRef(false);

  // Read sidebar preferences from cookies on mount (after hydration)
  useEffect(() => {
    if (hasReadCookies.current) {
      return;
    }
    hasReadCookies.current = true;

    // Read width
    const widthCookie = document.cookie
      .split("; ")
      .find((row) => row.startsWith("sidebar-width="));
    if (widthCookie) {
      const value = Number.parseFloat(widthCookie.split("=")[1]);
      if (!Number.isNaN(value) && value >= 20 && value <= 50) {
        setPanelWidth(value);
      }
    }

    // Read collapsed state
    const collapsedCookie = document.cookie
      .split("; ")
      .find((row) => row.startsWith("sidebar-collapsed="));
    if (collapsedCookie) {
      setPanelCollapsed(collapsedCookie.split("=")[1] === "true");
    }
  }, [setPanelCollapsed, setPanelWidth]);

  // Save sidebar width to cookie when it changes (skip initial render)
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (!hasInitialized.current) {
      hasInitialized.current = true;
      return;
    }
    // biome-ignore lint/suspicious/noDocumentCookie: simple cookie storage for sidebar width
    document.cookie = `sidebar-width=${panelWidth}; path=/; max-age=31536000`; // 1 year
  }, [panelWidth]);

  // Save collapsed state to cookie when it changes
  useEffect(() => {
    if (!hasReadCookies.current) {
      return;
    }
    // biome-ignore lint/suspicious/noDocumentCookie: simple cookie storage for sidebar state
    document.cookie = `sidebar-collapsed=${panelCollapsed}; path=/; max-age=31536000`; // 1 year
  }, [panelCollapsed]);

  // Trigger slide-in animation on mount (only for homepage -> workflow transition)
  useEffect(() => {
    // Check if we came from homepage
    const shouldAnimate = sessionStorage.getItem("animate-sidebar") === "true";
    sessionStorage.removeItem("animate-sidebar");

    // Skip animation if sidebar has already been shown (switching between workflows)
    // or if we didn't come from homepage (direct load, refresh)
    if (hasSidebarBeenShown || !shouldAnimate) {
      setPanelVisible(true);
      setHasSidebarBeenShown(true);
      return;
    }

    // Set animating state before starting
    setIsPanelAnimating(true);
    // Delay to ensure the canvas is visible at full width first
    const timer = setTimeout(() => {
      setPanelVisible(true);
      setHasSidebarBeenShown(true);
    }, 100);
    // Clear animating state after animation completes (300ms + buffer)
    const animationTimer = setTimeout(() => setIsPanelAnimating(false), 400);
    return () => {
      clearTimeout(timer);
      clearTimeout(animationTimer);
      setIsPanelAnimating(false);
    };
  }, [hasSidebarBeenShown, setHasSidebarBeenShown, setIsPanelAnimating]);

  // Keyboard shortcut Cmd/Ctrl+B to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setIsPanelAnimating(true);
        setPanelCollapsed((prev) => !prev);
        setTimeout(() => setIsPanelAnimating(false), 350);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setIsPanelAnimating, setPanelCollapsed]);

  // Set right panel width for AI prompt positioning
  // Only set it after the panel is visible (animated in) to coordinate the animation
  useEffect(() => {
    if (!isMobile && panelVisible && !panelCollapsed) {
      setRightPanelWidth(`${panelWidth}%`);
    } else {
      // During initial render or when collapsed, set to null so prompt is centered
      setRightPanelWidth(null);
    }
    return () => {
      setRightPanelWidth(null);
    };
  }, [isMobile, setRightPanelWidth, panelWidth, panelVisible, panelCollapsed]);

  // Handle panel resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      setIsDraggingResize(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) {
          return;
        }
        const newWidth =
          ((window.innerWidth - moveEvent.clientX) / window.innerWidth) * 100;
        // Clamp between 20% and 50%
        setPanelWidth(Math.min(50, Math.max(20, newWidth)));
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        setIsDraggingResize(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [setPanelWidth]
  );

  // Ref to track polling interval
  const executionPollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Ref to track polling interval for selected execution
  const selectedExecutionPollingIntervalRef = useRef<NodeJS.Timeout | null>(
    null
  );
  // Ref to access current nodes without triggering effect re-runs
  const nodesRef = useRef(nodes);

  // Keep nodes ref in sync
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // Helper function to generate workflow from AI
  const generateWorkflowFromAI = useCallback(
    async (prompt: string) => {
      setIsGenerating(true);
      setCurrentWorkflowId(workflowId);
      setCurrentWorkflowName("AI Generated Workflow");

      try {
        const workflowData = await api.ai.generate(prompt);

        // Clear selection on all nodes
        const nodesWithoutSelection = (workflowData.nodes || []).map(
          (node: WorkflowNode) => ({ ...node, selected: false })
        );
        setNodes(nodesWithoutSelection);
        setEdges(workflowData.edges || []);
        setCurrentWorkflowName(workflowData.name || "AI Generated Workflow");

        await api.workflow.update(workflowId, {
          name: workflowData.name,
          description: workflowData.description,
          nodes: workflowData.nodes,
          edges: workflowData.edges,
        });
      } catch (error) {
        console.error("Failed to generate workflow:", error);
        toast.error("Failed to generate workflow");
      } finally {
        setIsGenerating(false);
      }
    },
    [
      workflowId,
      setIsGenerating,
      setCurrentWorkflowId,
      setCurrentWorkflowName,
      setNodes,
      setEdges,
    ]
  );

  const hydrateListingAtoms = useCallback(
    (workflow: {
      isListed?: boolean;
      listedSlug?: string | null;
      listedAt?: string | null;
      inputSchema?: Record<string, unknown> | null;
      outputMapping?: Record<string, unknown> | null;
      priceUsdcPerCall?: string | null;
      shareExecutionStatus?: boolean;
    }) => {
      setCurrentWorkflowIsListed(workflow.isListed ?? false);
      setCurrentWorkflowListedSlug(workflow.listedSlug ?? null);
      setCurrentWorkflowListedAt(workflow.listedAt ?? null);
      setCurrentWorkflowInputSchema(workflow.inputSchema ?? null);
      setCurrentWorkflowOutputMapping(workflow.outputMapping ?? null);
      setCurrentWorkflowPriceUsdc(workflow.priceUsdcPerCall ?? null);
      setCurrentWorkflowShareExecutionStatus(
        workflow.shareExecutionStatus ?? false
      );
    },
    [
      setCurrentWorkflowIsListed,
      setCurrentWorkflowListedSlug,
      setCurrentWorkflowListedAt,
      setCurrentWorkflowInputSchema,
      setCurrentWorkflowOutputMapping,
      setCurrentWorkflowPriceUsdc,
      setCurrentWorkflowShareExecutionStatus,
    ]
  );

  // Helper function to load existing workflow
  const loadExistingWorkflow = useCallback(async () => {
    try {
      const workflow = await api.workflow.getById(workflowId);

      if (!workflow) {
        setWorkflowNotFound(true);
        return;
      }

      // Reset node statuses to idle and clear selection when loading from database
      const nodesWithIdleStatus = workflow.nodes.map((node: WorkflowNode) => ({
        ...node,
        selected: false,
        data: {
          ...node.data,
          status: "idle" as const,
        },
      }));

      setNodes(nodesWithIdleStatus);
      setEdges(workflow.edges);
      setCurrentWorkflowId(workflow.id);
      setCurrentWorkflowName(workflow.name);
      setCurrentWorkflowDescription(workflow.description || "");
      setCurrentWorkflowVisibility(
        (workflow.visibility as WorkflowVisibility) ?? "private"
      );
      setIsWorkflowOwner(workflow.isOwner !== false); // Default to true if not set
      setIsWorkflowEnabled(workflow.enabled ?? false); // keeperhub custom field //
      setCurrentWorkflowProjectId(workflow.projectId ?? null);
      setCurrentWorkflowTagId(workflow.tagId ?? null);
      setCurrentWorkflowPublicTags(workflow.publicTags ?? []);
      hydrateListingAtoms(workflow);
      setHasUnsavedChanges(false);
      setWorkflowNotFound(false);

      // Auto-select an unconfigured action node (fresh workflow from homepage)
      const emptyAction = nodesWithIdleStatus.find(
        (n: WorkflowNode) =>
          n.data.type === "action" && !n.data.config?.actionType
      );
      if (emptyAction) {
        setNodes(
          nodesWithIdleStatus.map((n: WorkflowNode) => ({
            ...n,
            selected: n.id === emptyAction.id,
          }))
        );
        setSelectedNode(emptyAction.id);
        setActiveTab("properties");
        setNewlyCreatedNodeId(emptyAction.id);
      }
    } catch (error) {
      console.error("Failed to load workflow:", error);
      setWorkflowNotFound(true);
    }
  }, [
    workflowId,
    setNodes,
    setEdges,
    setCurrentWorkflowId,
    setCurrentWorkflowName,
    setCurrentWorkflowVisibility,
    setIsWorkflowOwner,
    setIsWorkflowEnabled, // keeperhub custom field //
    setCurrentWorkflowProjectId,
    setCurrentWorkflowPublicTags,
    setCurrentWorkflowTagId,
    setHasUnsavedChanges,
    setWorkflowNotFound,
    setCurrentWorkflowDescription,
    setSelectedNode,
    setActiveTab,
    setNewlyCreatedNodeId,
    hydrateListingAtoms,
  ]);

  const { claimPending } = useClaimWorkflow(workflowId, loadExistingWorkflow);
  // Track if we've already auto-fixed integrations for this workflow+version
  const lastAutoFixRef = useRef<{ workflowId: string; version: number } | null>(
    null
  );

  // KEEP-542: workflow identity atoms are global Jotai singletons that persist
  // across navigation. After viewing a hub workflow (isOwner=false,
  // visibility=public), those values leak into the next workflow page until
  // loadExistingWorkflow resolves — leaving the persistent toolbar showing
  // "Use Template" for the user's own workflow, and worse, wiring its
  // currentWorkflowId to the previously viewed hub template (so clicking
  // "Use Template" duplicates the hub workflow). useLayoutEffect resets the
  // identity/content atoms before paint so the toolbar never sees stale state.
  const previousWorkflowIdRef = useRef<string | null>(null);
  useLayoutEffect((): (() => void) => {
    if (previousWorkflowIdRef.current !== workflowId) {
      previousWorkflowIdRef.current = workflowId;
      setCurrentWorkflowId(null);
      setCurrentWorkflowName("");
      setCurrentWorkflowDescription("");
      setCurrentWorkflowVisibility("private");
      setIsWorkflowOwner(true);
      setNodes([]);
      setEdges([]);
      setSelectedNode(null);
      setWorkflowNotFound(false);
      setPreviewVersion(null);
    }
    return (): void => {
      setCurrentWorkflowId(null);
      setCurrentWorkflowName("");
      setCurrentWorkflowDescription("");
      setCurrentWorkflowVisibility("private");
      setIsWorkflowOwner(true);
      setNodes([]);
      setEdges([]);
      setSelectedNode(null);
      setWorkflowNotFound(false);
      setPreviewVersion(null);
    };
  }, [
    workflowId,
    setCurrentWorkflowId,
    setCurrentWorkflowName,
    setCurrentWorkflowDescription,
    setCurrentWorkflowVisibility,
    setIsWorkflowOwner,
    setNodes,
    setEdges,
    setSelectedNode,
    setWorkflowNotFound,
    setPreviewVersion,
  ]);

  useEffect(() => {
    const loadWorkflowData = async () => {
      const pendingClaim = getPendingClaim();
      if (pendingClaim?.workflowId === workflowId) {
        return;
      }

      const isGeneratingParam = searchParams?.get("generating") === "true";
      const storedPrompt = sessionStorage.getItem("ai-prompt");
      const storedWorkflowId = sessionStorage.getItem("generating-workflow-id");

      // Check if state is already loaded for this workflow
      if (currentWorkflowId === workflowId && nodes.length > 0) {
        return;
      }

      // Check if we should generate from AI
      if (
        isGeneratingParam &&
        storedPrompt &&
        storedWorkflowId === workflowId
      ) {
        sessionStorage.removeItem("ai-prompt");
        sessionStorage.removeItem("generating-workflow-id");
        await generateWorkflowFromAI(storedPrompt);
      } else {
        await loadExistingWorkflow();
      }
    };

    loadWorkflowData();
  }, [
    workflowId,
    searchParams,
    currentWorkflowId,
    nodes.length,
    generateWorkflowFromAI,
    loadExistingWorkflow,
  ]);

  // Open a shared `?version=` link read-only: once the workflow is loaded,
  // reveal the History tab and (for a specific past version) preview it on the
  // canvas. "current" is the live version, so it opens history without a canvas
  // preview. Fires once per distinct version param; clears when removed.
  const { preview: previewVersionOnCanvas } = useVersionPreview();
  const appliedVersionParamRef = useRef<string | null>(null);
  useEffect(() => {
    const raw = searchParams?.get("version");
    if (!raw) {
      appliedVersionParamRef.current = null;
      return;
    }
    if (
      currentWorkflowId === workflowId &&
      appliedVersionParamRef.current !== raw
    ) {
      appliedVersionParamRef.current = raw;
      setSelectedNode(null);
      setActiveTab("history");
      if (raw !== "current") {
        const version = Number.parseInt(raw, 10);
        if (!Number.isNaN(version)) {
          previewVersionOnCanvas(version);
        }
      }
    }
  }, [
    searchParams,
    currentWorkflowId,
    workflowId,
    previewVersionOnCanvas,
    setSelectedNode,
    setActiveTab,
  ]);

  // Deep-link from the activity feed: `?tab=history` opens the workflow-level
  // History tab once the workflow is loaded (no specific version preview).
  // Fires once per distinct tab param.
  const appliedTabParamRef = useRef<string | null>(null);
  useEffect(() => {
    const tab = searchParams?.get("tab");
    if (tab !== "history") {
      appliedTabParamRef.current = null;
      return;
    }
    if (
      currentWorkflowId === workflowId &&
      appliedTabParamRef.current !== tab
    ) {
      appliedTabParamRef.current = tab;
      setSelectedNode(null);
      setActiveTab(tab);
    }
  }, [
    searchParams,
    currentWorkflowId,
    workflowId,
    setSelectedNode,
    setActiveTab,
  ]);

  // KEEP-323: Rehydrate the Run/Stop button when the page loads while an
  // execution is still in-flight. The toolbar's polling lives in component
  // memory, so a refresh mid-run leaves isExecutingAtom at its default
  // false and the button reverts to "Run". Here we detect a running
  // execution server-side, restore the atoms, and poll until it ends so
  // the button transitions back to "Run" automatically.
  const rehydratedWorkflowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentWorkflowId) {
      return;
    }
    if (isExecuting) {
      return;
    }
    if (rehydratedWorkflowIdRef.current === currentWorkflowId) {
      return;
    }

    let cancelled = false;
    let intervalId: NodeJS.Timeout | null = null;

    const isInFlightStatus = (status: string): boolean =>
      status === "running" || status === "pending";

    const pollResumedExecution = (executionId: string): void => {
      const poll = async (): Promise<void> => {
        try {
          const statusData = await api.workflow.getExecutionStatus(executionId);
          if (isInFlightStatus(statusData.status)) {
            return;
          }
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          if (executionPollingIntervalRef.current === intervalId) {
            executionPollingIntervalRef.current = null;
          }
          setIsExecuting(false);
          setCurrentExecutionId(null);
        } catch (error) {
          console.error("Failed to poll resumed execution:", error);
        }
      };

      poll();
      intervalId = setInterval(poll, 500);
      executionPollingIntervalRef.current = intervalId;
    };

    const rehydrate = async (): Promise<void> => {
      try {
        const executions = await api.workflow.getExecutions(currentWorkflowId);
        if (cancelled) {
          return;
        }
        rehydratedWorkflowIdRef.current = currentWorkflowId;
        const inFlight = executions.find((execution) =>
          isInFlightStatus(execution.status)
        );
        if (!inFlight) {
          return;
        }
        setCurrentExecutionId(inFlight.id);
        setIsExecuting(true);
        setSelectedExecutionId(inFlight.id);
        pollResumedExecution(inFlight.id);
      } catch (error) {
        console.error("Failed to rehydrate execution state:", error);
      }
    };

    rehydrate();

    return (): void => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
      if (executionPollingIntervalRef.current === intervalId) {
        executionPollingIntervalRef.current = null;
      }
    };
  }, [
    currentWorkflowId,
    isExecuting,
    setIsExecuting,
    setCurrentExecutionId,
    setSelectedExecutionId,
  ]);

  // Auto-fix invalid/missing integrations on workflow load or when integrations change
  useEffect(() => {
    // Skip if no nodes or no workflow
    if (nodes.length === 0 || !currentWorkflowId) {
      return;
    }

    // Skip for non-owners (they can't modify the workflow and may not be authenticated)
    if (!isOwner) {
      return;
    }

    // Skip if already checked for this workflow+version combination
    const lastFix = lastAutoFixRef.current;
    if (
      lastFix &&
      lastFix.workflowId === currentWorkflowId &&
      lastFix.version === integrationsVersion
    ) {
      return;
    }

    const autoFixIntegrations = async () => {
      try {
        const allIntegrations = await api.integration.getAll();
        setGlobalIntegrations(allIntegrations);
        setIntegrationsLoaded(true);

        const validIds = new Set(allIntegrations.map((i) => i.id));
        const fixes = nodes
          .map((node) => checkNodeIntegration(node, allIntegrations, validIds))
          .filter((fix): fix is IntegrationFixResult => fix !== null);

        for (const fix of fixes) {
          const node = nodes.find((n) => n.id === fix.nodeId);
          if (node) {
            updateNodeData({
              id: fix.nodeId,
              data: {
                config: {
                  ...node.data.config,
                  integrationId: fix.newIntegrationId,
                },
              },
            });
          }
        }

        lastAutoFixRef.current = {
          workflowId: currentWorkflowId,
          version: integrationsVersion,
        };
        if (fixes.length > 0) {
          setHasUnsavedChanges(true);
        }
      } catch (error) {
        console.error("Failed to auto-fix integrations:", error);
      }
    };

    autoFixIntegrations();
  }, [
    nodes,
    currentWorkflowId,
    integrationsVersion,
    isOwner,
    updateNodeData,
    setGlobalIntegrations,
    setIntegrationsLoaded,
    setHasUnsavedChanges,
  ]);

  // Keyboard shortcuts
  const handleSave = useCallback(async () => {
    if (!currentWorkflowId || isGenerating) {
      return;
    }
    setIsSaving(true);
    try {
      await api.workflow.update(currentWorkflowId, { nodes, edges });
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error("Failed to save workflow:", error);
      toast.error("Failed to save workflow");
    } finally {
      setIsSaving(false);
    }
  }, [
    currentWorkflowId,
    nodes,
    edges,
    isGenerating,
    setIsSaving,
    setHasUnsavedChanges,
  ]);

  // Helper to check if target is an input element
  const isInputElement = useCallback(
    (target: HTMLElement) =>
      target.tagName === "INPUT" || target.tagName === "TEXTAREA",
    []
  );

  // Helper to check if we're in Monaco editor
  const isInMonacoEditor = useCallback(
    (target: HTMLElement) => target.closest(".monaco-editor") !== null,
    []
  );

  // Helper to handle save shortcut
  const handleSaveShortcut = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        handleSave();
        return true;
      }
      return false;
    },
    [handleSave]
  );

  // Helper to handle run shortcut
  // Uses triggerExecuteAtom to share the same execute flow as the Run button
  // This ensures keyboard shortcut goes through the same checks (e.g., missing integrations)
  const handleRunShortcut = useCallback(
    (e: KeyboardEvent, target: HTMLElement) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (!(isInputElement(target) || isInMonacoEditor(target))) {
          e.preventDefault();
          e.stopPropagation();
          // Trigger execute via atom - the toolbar will handle it
          setTriggerExecute(true);
        }
        return true;
      }
      return false;
    },
    [setTriggerExecute, isInputElement, isInMonacoEditor]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // Handle save shortcut
      if (handleSaveShortcut(e)) {
        return;
      }

      // Handle run shortcut
      if (handleRunShortcut(e, target)) {
        return;
      }
    };

    // Use capture phase only to ensure we can intercept before other handlers
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleSaveShortcut, handleRunShortcut]);

  // Cleanup polling interval on unmount
  useEffect(
    () => () => {
      if (executionPollingIntervalRef.current) {
        clearInterval(executionPollingIntervalRef.current);
      }
      if (selectedExecutionPollingIntervalRef.current) {
        clearInterval(selectedExecutionPollingIntervalRef.current);
      }
    },
    []
  );

  // Poll for selected execution status
  useEffect(() => {
    // Clear existing interval if any
    if (selectedExecutionPollingIntervalRef.current) {
      clearInterval(selectedExecutionPollingIntervalRef.current);
      selectedExecutionPollingIntervalRef.current = null;
    }

    // If no execution is selected or it's the currently running one, don't poll
    if (!selectedExecutionId) {
      // Reset all node statuses when no execution is selected
      for (const node of nodesRef.current) {
        updateNodeData({ id: node.id, data: { status: "idle" } });
      }
      return;
    }

    // Start polling for the selected execution
    const pollSelectedExecution = async () => {
      try {
        const statusData =
          await api.workflow.getExecutionStatus(selectedExecutionId);

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
        if (
          statusData.status !== "running" &&
          selectedExecutionPollingIntervalRef.current
        ) {
          clearInterval(selectedExecutionPollingIntervalRef.current);
          selectedExecutionPollingIntervalRef.current = null;
        }
      } catch (error) {
        console.error("Failed to poll selected execution status:", error);
        // Clear polling on error
        if (selectedExecutionPollingIntervalRef.current) {
          clearInterval(selectedExecutionPollingIntervalRef.current);
          selectedExecutionPollingIntervalRef.current = null;
        }
      }
    };

    // Poll immediately and then every 500ms
    pollSelectedExecution();
    const pollInterval = setInterval(pollSelectedExecution, 500);
    selectedExecutionPollingIntervalRef.current = pollInterval;

    return () => {
      if (selectedExecutionPollingIntervalRef.current) {
        clearInterval(selectedExecutionPollingIntervalRef.current);
        selectedExecutionPollingIntervalRef.current = null;
      }
    };
  }, [selectedExecutionId, updateNodeData]);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      {/* Workflow not found overlay */}
      {workflowNotFound && !claimPending && (
        <div className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center">
          <div className="rounded-lg border bg-background p-8 text-center shadow-lg">
            <h1 className="mb-2 font-semibold text-2xl">Workflow Not Found</h1>
            <p className="mb-6 text-muted-foreground">
              The workflow you're looking for doesn't exist or has been deleted.
            </p>
            <div className="flex justify-center gap-3">
              <Button
                className="gap-2"
                onClick={async () => {
                  try {
                    await ensureSession();
                    const triggerId = `trigger-${Date.now()}`;
                    const actionId = `action-${Date.now()}`;
                    const triggerNode = {
                      id: triggerId,
                      type: "trigger" as const,
                      position: { x: 400, y: 200 },
                      data: {
                        label: "",
                        type: "trigger" as const,
                        config: { triggerType: "Manual" },
                        status: "idle" as const,
                      },
                    };
                    const actionNode = {
                      id: actionId,
                      type: "action" as const,
                      position: { x: 672, y: 200 },
                      selected: true,
                      data: {
                        label: "",
                        type: "action" as const,
                        config: {},
                        status: "idle" as const,
                      },
                    };
                    const newWorkflow = await api.workflow.create({
                      name: "Untitled Workflow",
                      description: "",
                      nodes: [triggerNode, actionNode],
                      edges: [
                        {
                          id: `edge-${Date.now()}`,
                          source: triggerId,
                          target: actionId,
                          type: "animated",
                        },
                      ],
                    });
                    router.replace(`/workflows/${newWorkflow.id}`);
                  } catch (error) {
                    console.error("Failed to create workflow:", error);
                    toast.error("Failed to create workflow. Please try again.");
                  }
                }}
              >
                <Plus className="size-4" />
                Start building
              </Button>
              <Button
                className="gap-2"
                onClick={() => router.push("/hub")}
                variant="outline"
              >
                <Globe className="size-4" />
                Browse Templates
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Expand button when panel is collapsed - only show if trigger exists */}
      {!isMobile && hasTriggerNode && panelCollapsed && (
        <button
          className="pointer-events-auto absolute top-[calc(60px+0.75rem)] right-0 z-20 flex size-6 items-center justify-center rounded-l-full border border-r-0 bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => {
            setIsPanelAnimating(true);
            setPanelCollapsed(false);
            setTimeout(() => setIsPanelAnimating(false), 350);
          }}
          type="button"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}

      {/* Right panel overlay (desktop only) - only show if trigger exists */}
      {!isMobile && hasTriggerNode && (
        <div
          className="pointer-events-auto absolute top-[calc(6rem+var(--app-banner-height,0px))] right-0 bottom-0 z-20 border-l bg-background transition-transform duration-300 ease-out lg:top-[calc(60px+var(--app-banner-height,0px))]"
          style={{
            width: `${panelWidth}%`,
            transform:
              panelVisible && !panelCollapsed
                ? "translateX(0)"
                : "translateX(100%)",
          }}
        >
          {/* Resize handle with collapse button */}
          {/* biome-ignore lint/a11y/useSemanticElements: custom resize handle */}
          <div
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            className="group absolute inset-y-0 left-0 z-10 w-3 cursor-col-resize"
            onMouseDown={handleResizeStart}
            role="separator"
            tabIndex={0}
          >
            <div className="absolute inset-y-0 left-0 w-px bg-border" />
            {!(isDraggingResize || panelCollapsed) && (
              <button
                className="absolute top-3 left-0 flex size-6 -translate-x-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsPanelAnimating(true);
                  setPanelCollapsed(true);
                  setTimeout(() => setIsPanelAnimating(false), 350);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                type="button"
              >
                <ChevronRight className="size-3.5" />
              </button>
            )}
          </div>
          <NodeConfigPanel />
        </div>
      )}

      {/* Mobile: NodeConfigPanel renders the overlay trigger button - only show if trigger exists */}
      {isMobile && hasTriggerNode && <NodeConfigPanel />}
    </div>
  );
};

const WorkflowPage = ({ params }: WorkflowPageProps) => {
  const { workflowId } = use(params);
  return <WorkflowEditor workflowId={workflowId} />;
};

export default WorkflowPage;
