"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BUILTIN_NODE_ID, BUILTIN_NODE_LABEL, BUILTIN_VARIABLE_FIELDS } from "@/lib/workflow/editor/builtin-variables";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  getAvailableFields,
  type NodeOutputs,
} from "@/lib/utils/template";
import {
  currentWorkflowIdAtom,
  currentWorkflowInputSchemaAtom,
  edgesAtom,
  executionLogsAtom,
  type ExecutionLogEntry,
  lastExecutionLogsAtom,
  nodesAtom,
  WorkflowTriggerEnum,
  type WorkflowNode,
} from "@/lib/workflow/store";
import { findActionById } from "@/plugins/registry";
import { getReadContractOutputFields } from "@/lib/workflow/editor/action-output-fields";
import { resolveForEachSyntheticOutput } from "@/lib/workflow/nodes/for-each/utils";
import {
  type ExecutionLogsByNodeId,
  type SchemaField,
  buildExecutionLogsMap,
  getNodeDisplayName,
  isActionType,
  sanitizeNodeId,
  schemaToFields,
} from "@/lib/workflow/editor/template-helpers";
import {
  type IndexedAutocompleteOption,
  buildHaystack,
  filterOptionsByQuery,
} from "@/lib/workflow/editor/template-autocomplete-filter";
import { getInputSchemaFields } from "@/lib/workflow/editor/input-schema-fields";
import { getTriggerOutputFields } from "@/lib/workflow/editor/trigger-output-fields";

/**
 * - "escape": user pressed Escape while in the search input -- return focus
 *   to the editor so they can keep typing.
 * - "outside": user clicked/tapped somewhere outside the dropdown -- let
 *   focus flow wherever the click landed and don't refocus the editor.
 */
export type TemplateAutocompleteCloseReason = "escape" | "outside";

type TemplateAutocompleteProps = {
  isOpen: boolean;
  position: { top: number; left: number };
  onSelect: (template: string) => void;
  onClose: (reason: TemplateAutocompleteCloseReason) => void;
  currentNodeId?: string;
};

// Get common fields based on node action type
const getCommonFields = (node: WorkflowNode) => {
  const actionType = node.data.config?.actionType as string | undefined;

  // Special handling for dynamic outputs (system actions and schema-based)
  if (actionType === "HTTP Request") {
    return [
      { field: "data", description: "Response data" },
      { field: "status", description: "HTTP status code" },
    ];
  }

  if (actionType === "Database Query") {
    const dbSchema = node.data.config?.dbSchema as string | undefined;
    if (dbSchema) {
      try {
        const schema = JSON.parse(dbSchema) as SchemaField[];
        if (schema.length > 0) {
          return schemaToFields(schema);
        }
      } catch {
        // If schema parsing fails, fall through to default fields
      }
    }
    return [
      { field: "rows", description: "Query result rows" },
      { field: "count", description: "Number of rows" },
    ];
  }

  // AI Gateway generate-text has dynamic output based on format/schema
  if (isActionType(actionType, "Generate Text", "ai-gateway/generate-text")) {
    const aiFormat = node.data.config?.aiFormat as string | undefined;
    const aiSchema = node.data.config?.aiSchema as string | undefined;

    if (aiFormat === "object" && aiSchema) {
      try {
        const schema = JSON.parse(aiSchema) as SchemaField[];
        if (schema.length > 0) {
          return schemaToFields(schema, "object");
        }
      } catch {
        // If schema parsing fails, fall through to default fields
      }
    }
    return [{ field: "text", description: "Generated text" }];
  }

  // Check for Read Contract action with dynamic outputs based on ABI
  // This must be BEFORE the plugin outputFields check to override static fields
  if (isActionType(actionType, "Read Contract", "web3/read-contract")) {
    const abi = node.data.config?.abi as string | undefined;
    const abiFunction = node.data.config?.abiFunction as string | undefined;
    const dynamicFields = getReadContractOutputFields(abi, abiFunction);
    if (dynamicFields.length > 0) {
      return dynamicFields;
    }
  }

  if (actionType === "For Each") {
    return [
      {
        field: "currentItem",
        description: "Current array element (inside loop body)",
      },
      { field: "index", description: "Current iteration index (0-based)" },
      {
        field: "totalItems",
        description: "Total number of items in array",
      },
    ];
  }

  if (actionType === "Collect") {
    return [
      {
        field: "results",
        description: "Array of outputs from each iteration",
      },
      { field: "count", description: "Number of completed iterations" },
    ];
  }

  // Check if the plugin defines output fields
  if (actionType) {
    const action = findActionById(actionType);
    if (action?.outputFields && action.outputFields.length > 0) {
      return action.outputFields;
    }
  }

  // Trigger fields
  if (node.data.type === "trigger") {
    const triggerType = node.data.config?.triggerType as string | undefined;
    const webhookSchema = node.data.config?.webhookSchema as string | undefined;

    // Use keeperhub trigger output fields function for Event triggers
    if (triggerType === WorkflowTriggerEnum.EVENT) {
      const outputFields = getTriggerOutputFields(
        triggerType,
        node.data.config || {}
      );
      if (outputFields.length > 0) {
        return outputFields;
      }
    }

    if (triggerType === "Webhook" && webhookSchema) {
      try {
        const schema = JSON.parse(webhookSchema) as SchemaField[];
        if (schema.length > 0) {
          return schemaToFields(schema);
        }
      } catch {
        // If schema parsing fails, fall through to default fields
      }
    }

    // Use keeperhub trigger output fields function for other trigger types
    if (triggerType) {
      const outputFields = getTriggerOutputFields(
        triggerType,
        node.data.config || {}
      );
      if (outputFields.length > 0) {
        return outputFields;
      }
    }

    return [
      { field: "triggered", description: "Trigger status" },
      { field: "timestamp", description: "Trigger timestamp" },
      { field: "input", description: "Input data" },
    ];
  }

  return [{ field: "data", description: "Output data" }];
};
export function TemplateAutocomplete({
  isOpen,
  position,
  onSelect,
  onClose,
  currentNodeId,
}: TemplateAutocompleteProps) {
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const executionLogs = useAtomValue(executionLogsAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const workflowInputSchema = useAtomValue(currentWorkflowInputSchemaAtom);
  const lastExecutionLogs = useAtomValue(lastExecutionLogsAtom);
  const setLastExecutionLogs = useSetAtom(lastExecutionLogsAtom);
  const currentWorkflowIdRef = useRef<string | null>(null);
  const lastFetchWorkflowIdRef = useRef<string | null>(null);
  currentWorkflowIdRef.current = currentWorkflowId;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);

  // Reset search + selection whenever the dropdown opens, and focus the search input
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setSearchQuery("");
    setSelectedIndex(0);
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  // Ensure we're mounted before trying to use portal
  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Lazy-load last execution logs when autocomplete opens and we have no logs for this workflow.
  // Race guards: (1) lastFetchWorkflowIdRef prevents double-fetch for same workflow;
  // (2) only set state when currentWorkflowIdRef.current === workflowId so we never apply stale data after navigation.
  useEffect(() => {
    const alreadyHaveLogs =
      lastExecutionLogs.workflowId === currentWorkflowId;
    const fetchAlreadyInProgress =
      lastFetchWorkflowIdRef.current === currentWorkflowId;
    const shouldNotFetch =
      !isOpen ||
      !currentWorkflowId ||
      alreadyHaveLogs ||
      fetchAlreadyInProgress;

    if (shouldNotFetch) return;

    const workflowId = currentWorkflowId;
    lastFetchWorkflowIdRef.current = workflowId;

    let cancelled = false;

    const fetchLogs = async () => {
      try {
        const executions = await api.workflow.getExecutions(workflowId);
        if (cancelled) {
          return;
        }
        const latest = executions[0];
        if (!latest?.id) {
          lastFetchWorkflowIdRef.current = null;
          return;
        }

        const { logs } = await api.workflow.getExecutionLogs(latest.id);
        if (cancelled) {
          return;
        }

        const logsByNodeId = buildExecutionLogsMap(logs);

        if (
          !cancelled &&
          currentWorkflowIdRef.current === workflowId
        ) {
          setLastExecutionLogs({ workflowId, logs: logsByNodeId });
        }
      } catch {
        // Non-blocking: keep getCommonFields fallback
      } finally {
        if (lastFetchWorkflowIdRef.current === workflowId) {
          lastFetchWorkflowIdRef.current = null;
        }
      }
    };

    fetchLogs();

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    currentWorkflowId,
    lastExecutionLogs.workflowId,
    setLastExecutionLogs,
  ]);

  // Find all nodes that come before the current node
  const upstreamNodes = useMemo(() => {
    if (!currentNodeId) {
      return [];
    }

    const visited = new Set<string>();
    const upstream: string[] = [];

    const traverse = (nodeId: string): void => {
      if (visited.has(nodeId)) {
        return;
      }
      visited.add(nodeId);

      const incomingEdges = edges.filter((edge) => edge.target === nodeId);
      for (const edge of incomingEdges) {
        upstream.push(edge.source);
        traverse(edge.source);
      }
    };

    traverse(currentNodeId);

    return nodes.filter((node) => upstream.includes(node.id));
  }, [nodes, edges, currentNodeId]);

  // Build list of all available options (nodes + their fields). Memoized so
  // typing in the search input doesn't re-traverse the DAG, re-resolve For
  // Each synthetic outputs, or re-compute execution-log-derived field maps.
  // Each option carries a precomputed lowercase `haystack` so filtering is a
  // cheap substring/subsequence scan per keystroke.
  const options = useMemo<IndexedAutocompleteOption[]>(() => {
    const result: IndexedAutocompleteOption[] = [];
    const lastLogsForWorkflow =
      lastExecutionLogs.workflowId === currentWorkflowId
        ? lastExecutionLogs.logs
        : ({} as ExecutionLogsByNodeId);

    const pushOption = (
      opt: Omit<IndexedAutocompleteOption, "haystack">
    ): void => {
      result.push({ ...opt, haystack: buildHaystack(opt) });
    };

    for (const node of upstreamNodes) {
      const nodeName = getNodeDisplayName(node);
      const runtimeOutput = executionLogs[node.id]?.output;
      const hasRuntimeOutput =
        runtimeOutput !== undefined && runtimeOutput !== null;
      const lastRunOutput = lastLogsForWorkflow[node.id]?.output;
      const hasLastRunOutput =
        lastRunOutput !== undefined && lastRunOutput !== null;

      const outputToUse = hasRuntimeOutput
        ? runtimeOutput
        : hasLastRunOutput
          ? lastRunOutput
          : null;

      // For Each nodes: override with synthetic output so autocomplete shows
      // the actual currentItem shape (nested fields) instead of the step's
      // generic metadata. Resolves the arraySource from upstream execution data.
      const actionType = node.data.config?.actionType as string | undefined;
      if (actionType === "For Each") {
        const syntheticOutput = resolveForEachSyntheticOutput(
          node,
          executionLogs,
          lastLogsForWorkflow,
          upstreamNodes
        );

        if (syntheticOutput) {
          const sanitizedId = sanitizeNodeId(node.id);
          const nodeOutputs: NodeOutputs = {
            [sanitizedId]: { label: nodeName, data: syntheticOutput },
          };
          const runtimeFields = getAvailableFields(nodeOutputs);

          pushOption({
            type: "node",
            nodeId: node.id,
            nodeName,
            template: `{{@${node.id}:${nodeName}}}`,
          });

          for (const entry of runtimeFields) {
            if (entry.fieldPath === "" && entry.field === "") {
              continue;
            }
            const fieldPath = entry.fieldPath || entry.field;
            pushOption({
              type: "field",
              nodeId: node.id,
              nodeName,
              field: fieldPath,
              description: undefined,
              template: `{{@${node.id}:${nodeName}.${fieldPath}}}`,
            });
          }
        } else {
          const fields = getCommonFields(node);
          pushOption({
            type: "node",
            nodeId: node.id,
            nodeName,
            template: `{{@${node.id}:${nodeName}}}`,
          });
          for (const field of fields) {
            pushOption({
              type: "field",
              nodeId: node.id,
              nodeName,
              field: field.field,
              description: field.description,
              template: `{{@${node.id}:${nodeName}.${field.field}}}`,
            });
          }
        }
        continue;
      }

      if (outputToUse !== null) {
        const sanitizedId = sanitizeNodeId(node.id);
        const nodeOutputs: NodeOutputs = {
          [sanitizedId]: {
            label: nodeName,
            data: outputToUse,
          },
        };
        const runtimeFields = getAvailableFields(nodeOutputs);

        pushOption({
          type: "node",
          nodeId: node.id,
          nodeName,
          template: `{{@${node.id}:${nodeName}}}`,
        });

        for (const entry of runtimeFields) {
          if (entry.fieldPath === "" && entry.field === "") {
            continue;
          }
          const fieldPath = entry.fieldPath || entry.field;
          pushOption({
            type: "field",
            nodeId: node.id,
            nodeName,
            field: fieldPath,
            description: undefined,
            template: `{{@${node.id}:${nodeName}.${fieldPath}}}`,
          });
        }
      } else {
        const fields = getCommonFields(node);

        pushOption({
          type: "node",
          nodeId: node.id,
          nodeName,
          template: `{{@${node.id}:${nodeName}}}`,
        });

        for (const field of fields) {
          pushOption({
            type: "field",
            nodeId: node.id,
            nodeName,
            field: field.field,
            description: field.description,
            template: `{{@${node.id}:${nodeName}.${field.field}}}`,
          });
        }
      }

      // Listed-workflow inputSchema fields are exposed under data.<fieldName>
      // because the executor merges request body into the trigger output's
      // data at runtime. Inject them on both the runtime and static paths so
      // they are available even before an agent has called the workflow, and
      // dedupe against fields already pushed for this node so a runtime log
      // that already captured them does not double-list.
      if (node.data.type === "trigger" && workflowInputSchema) {
        const schemaFields = getInputSchemaFields(workflowInputSchema);
        if (schemaFields.length > 0) {
          const existing = new Set<string>();
          for (const opt of result) {
            if (opt.nodeId === node.id && opt.type === "field" && opt.field) {
              existing.add(opt.field);
            }
          }
          for (const field of schemaFields) {
            if (existing.has(field.field)) {
              continue;
            }
            pushOption({
              type: "field",
              nodeId: node.id,
              nodeName,
              field: field.field,
              description: field.description,
              template: `{{@${node.id}:${nodeName}.${field.field}}}`,
            });
          }
        }
      }
    }

    // Built-in system variables (available to all nodes, evaluated at execution time)
    for (const field of BUILTIN_VARIABLE_FIELDS) {
      pushOption({
        type: "field",
        nodeId: BUILTIN_NODE_ID,
        nodeName: BUILTIN_NODE_LABEL,
        field: field.field,
        description: field.description,
        template: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.${field.field}}}`,
      });
    }

    return result;
  }, [
    upstreamNodes,
    executionLogs,
    lastExecutionLogs,
    currentWorkflowId,
    workflowInputSchema,
  ]);

  // Case-insensitive substring search: each whitespace-separated token must
  // appear as a contiguous substring somewhere in the precomputed haystack.
  // Substring (not subsequence) avoids noisy matches where chars appear in
  // order but spread across unrelated parts of the name/field.
  const filteredOptions = useMemo(
    () => filterOptionsByQuery(options, searchQuery),
    [options, searchQuery]
  );

  // Reset selection when the result set shrinks below the current index
  useEffect(() => {
    setSelectedIndex((prev) =>
      prev >= filteredOptions.length ? 0 : prev
    );
  }, [filteredOptions.length]);

  // Close the dropdown on any pointerdown outside of it. The parent editor's
  // blur timeout only triggers when focus actually moves, so clicks on
  // non-focusable elements (text, panels, etc.) would otherwise leave the
  // dropdown open. We ignore clicks inside the menu itself so option clicks
  // still register.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("[data-template-autocomplete]")
      ) {
        return;
      }
      onClose("outside");
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen, onClose]);

  const handleSearchKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filteredOptions.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "Enter": {
        e.preventDefault();
        const option = filteredOptions[selectedIndex];
        if (option) {
          onSelect(option.template);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        onClose("escape");
        break;
      default:
        break;
    }
  };

  // Scroll selected item into view (options live inside the scrollable list, not menuRef)
  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return
    };
    const selectedElement = list.children[selectedIndex] as HTMLElement;
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex]);

  if (!(isOpen && mounted)) {
    return null;
  }

  // Ensure position is within viewport
  const adjustedPosition = {
    top: Math.min(position.top, window.innerHeight - 300), // Keep 300px from bottom
    left: Math.min(position.left, window.innerWidth - 320), // Keep menu (320px wide) within viewport
  };

  const menuContent = (
    <div
      className="fixed z-9999 flex w-80 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md"
      data-template-autocomplete=""
      ref={menuRef}
      style={{
        top: `${adjustedPosition.top}px`,
        left: `${adjustedPosition.left}px`,
      }}
    >
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label="Search variables"
          autoComplete="off"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search variables..."
          ref={searchInputRef}
          type="text"
          value={searchQuery}
        />
      </div>
      {filteredOptions.length === 0 ? (
        <div className="px-3 py-6 text-center text-muted-foreground text-sm">
          No variables found
        </div>
      ) : (
        <div className="max-h-60 overflow-y-auto p-1" ref={listRef}>
          {filteredOptions.map((option, index) => (
            <button
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors",
                index === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              )}
              key={`${option.nodeId}-${option.field ?? "root"}`}
              onClick={() => onSelect(option.template)}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelectedIndex(index)}
              type="button"
            >
              <div className="flex-1">
                <div className="font-medium">
                  {option.type === "node" ? (
                    option.nodeName
                  ) : (
                    <>
                      <span className="text-muted-foreground">
                        {option.nodeName}.
                      </span>
                      {option.field}
                    </>
                  )}
                </div>
                {option.description && (
                  <div className="text-muted-foreground text-xs">
                    {option.description}
                  </div>
                )}
              </div>
              {index === selectedIndex && <Check className="h-4 w-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // Use portal to render at document root to avoid clipping issues
  return createPortal(menuContent, document.body);
}

