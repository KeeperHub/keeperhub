"use client";

import type { Edge, Node, XYPosition } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { Link2Off, Plus, Trash2, Upload } from "lucide-react";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WorkflowIOOverlay } from "@/components/overlays/workflow-io-overlay";
import { useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { cn } from "@/lib/utils";
import {
  addNodeAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  nodesAtom,
  propertiesPanelActiveTabAtom,
  selectedNodeAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";
import { useShowStepSettings } from "./use-show-step-settings";

export type ContextMenuType = "node" | "edge" | "pane" | null;

// The menu keeps this far inside the window.
const MENU_EDGE_GAP_PX = 8;

export type ContextMenuState = {
  type: ContextMenuType;
  position: { x: number; y: number };
  flowPosition?: XYPosition;
  nodeId?: string;
  edgeId?: string;
} | null;

type WorkflowContextMenuProps = {
  menuState: ContextMenuState;
  onClose: () => void;
};

export function WorkflowContextMenu({
  menuState,
  onClose,
}: WorkflowContextMenuProps) {
  const nodes = useAtomValue(nodesAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const addNode = useSetAtom(addNodeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const { open: openOverlay } = useOverlay();
  const showStepSettings = useShowStepSettings();
  const router = useRouter();
  const { data: session } = useSession();
  const isAnonymous = isAnonymousUser(session?.user);
  const menuRef = useRef<HTMLDivElement>(null);
  const [ioOpen, setIoOpen] = useState(false);
  const [placed, setPlaced] = useState<{ x: number; y: number } | null>(null);

  // Before paint: open upward near the bottom edge, shift left near the right.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!(menuState && menu)) {
      setPlaced(null);
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    const { x, y } = menuState.position;
    const room = (size: number, max: number): number =>
      Math.max(MENU_EDGE_GAP_PX, max - size - MENU_EDGE_GAP_PX);
    setPlaced({
      x: Math.min(x, room(width, window.innerWidth)),
      y:
        y + height > window.innerHeight - MENU_EDGE_GAP_PX
          ? Math.min(Math.max(MENU_EDGE_GAP_PX, y - height), room(height, window.innerHeight))
          : y,
    });
  }, [menuState]);

  const handleIoImported = useCallback(
    (workflowId: string) => {
      router.push(`/workflows/${workflowId}`);
    },
    [router]
  );

  const handleNoopExport = useCallback(() => {
    // Pane context-menu entry is import-only. The export section in the
    // shared overlay is not reachable from this entry point because the
    // menu opens in pane context where there is no current workflow to
    // export. Keeping a no-op satisfies the overlay's required prop.
  }, []);

  const handleDeleteNode = useCallback(() => {
    if (menuState?.nodeId) {
      const nodeId = menuState.nodeId;
      onClose();
      openOverlay(ConfirmOverlay, {
        title: "Delete Step",
        message:
          "Are you sure you want to delete this node? This action cannot be undone.",
        confirmLabel: "Delete",
        confirmVariant: "destructive" as const,
        onConfirm: () => {
          deleteNode(nodeId);
        },
      });
    }
  }, [menuState, deleteNode, onClose, openOverlay]);

  const handleDeleteEdge = useCallback(() => {
    if (menuState?.edgeId) {
      const edgeId = menuState.edgeId;
      onClose();
      openOverlay(ConfirmOverlay, {
        title: "Delete Connection",
        message:
          "Are you sure you want to delete this connection? This action cannot be undone.",
        confirmLabel: "Delete",
        confirmVariant: "destructive" as const,
        onConfirm: () => {
          deleteEdge(edgeId);
        },
      });
    }
  }, [menuState, deleteEdge, onClose, openOverlay]);

  const handleAddStep = useCallback(() => {
    if (menuState?.flowPosition) {
      const nodeHeight = 192;
      const newNode: WorkflowNode = {
        id: nanoid(),
        type: "action",
        position: {
          x: menuState.flowPosition.x,
          y: menuState.flowPosition.y - nodeHeight / 2,
        },
        data: {
          label: "",
          description: "",
          type: "action",
          config: {},
          status: "idle",
        },
        selected: true,
      };
      addNode(newNode);
      setSelectedNode(newNode.id);
      setActiveTab("properties");
      showStepSettings(newNode);
    }
    onClose();
  }, [
    menuState,
    addNode,
    setSelectedNode,
    setActiveTab,
    showStepSettings,
    onClose,
  ]);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuState) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as globalThis.Node)
      ) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    // Use a small timeout to prevent the menu from closing immediately
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuState, onClose]);

  const getNodeLabel = (): string => {
    if (!menuState?.nodeId) {
      return "Step";
    }
    const node = nodes.find((n) => n.id === menuState.nodeId);
    return node?.data.label || "Step";
  };

  return (
    <>
      {/* On body: inside the canvas's z-0 layer, fixed bars would cover it. */}
      {menuState &&
        createPortal(
          <div
            className="fade-in-0 zoom-in-95 fixed z-50 min-w-[8rem] animate-in overflow-hidden whitespace-nowrap rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            ref={menuRef}
            style={{
              left: (placed ?? menuState.position).x,
              top: (placed ?? menuState.position).y,
            }}
          >
            {menuState.type === "node" && (
              <MenuItem
                icon={<Trash2 className="size-4" />}
                label={`Delete ${getNodeLabel()}`}
                onClick={handleDeleteNode}
                variant="destructive"
              />
            )}

            {menuState.type === "edge" && (
              <MenuItem
                icon={<Link2Off className="size-4" />}
                label="Delete Connection"
                onClick={handleDeleteEdge}
                variant="destructive"
              />
            )}

            {menuState.type === "pane" && (
              <>
                <MenuItem
                  icon={<Plus className="size-4" />}
                  label="Add Step"
                  onClick={handleAddStep}
                />
                <MenuItem
                  icon={<Upload className="size-4" />}
                  label="New Workflow from JSON"
                  onClick={() => {
                    onClose();
                    if (isAnonymous) {
                      toast.info("Sign in to import workflows.");
                      return;
                    }
                    setIoOpen(true);
                  }}
                />
              </>
            )}
          </div>,
          document.body
        )}
      <WorkflowIOOverlay
        onExport={handleNoopExport}
        onImported={handleIoImported}
        onOpenChange={setIoOpen}
        open={ioOpen}
      />
    </>
  );
}

type MenuItemProps = {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
};

function MenuItem({
  icon,
  label,
  onClick,
  variant = "default",
  disabled,
}: MenuItemProps) {
  return (
    <button
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
        "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        variant === "destructive" &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive",
        disabled && "pointer-events-none opacity-50"
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

// Hook helpers for using with React Flow
export function useContextMenuHandlers(
  screenToFlowPosition: (position: { x: number; y: number }) => XYPosition,
  setMenuState: (state: ContextMenuState) => void
) {
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const data = node.data as WorkflowNode["data"] | undefined;
      if (data?.type === "trigger") {
        return;
      }
      setMenuState({
        type: "node",
        position: { x: event.clientX, y: event.clientY },
        nodeId: node.id,
      });
    },
    [setMenuState]
  );

  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      setMenuState({
        type: "edge",
        position: { x: event.clientX, y: event.clientY },
        edgeId: edge.id,
      });
    },
    [setMenuState]
  );

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      const flowPosition = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setMenuState({
        type: "pane",
        position: { x: event.clientX, y: event.clientY },
        flowPosition,
      });
    },
    [screenToFlowPosition, setMenuState]
  );

  return {
    onNodeContextMenu,
    onEdgeContextMenu,
    onPaneContextMenu,
  };
}
