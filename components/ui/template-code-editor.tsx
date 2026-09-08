"use client";

import type { EditorProps, Monaco, OnMount } from "@monaco-editor/react";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { CodeEditor } from "@/components/ui/code-editor";
import { api } from "@/lib/api-client";
import { getInputSchemaFields } from "@/lib/workflow/editor/input-schema-fields";
import {
  buildExecutionLogsMap,
  type ExecutionLogsByNodeId,
  findActiveAtIndex,
  findDuplicateTemplateLabels,
  getCommonFields,
  getNodeDisplayName,
  sanitizeNodeId,
} from "@/lib/workflow/editor/template-helpers";
import { useStableRef } from "@/lib/use-stable-ref";
import { getAvailableFields, type NodeOutputs } from "@/lib/utils/template";
import {
  currentWorkflowIdAtom,
  currentWorkflowInputSchemaAtom,
  edgesAtom,
  executionLogsAtom,
  lastExecutionLogsAtom,
  nodesAtom,
  selectedNodeAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DEFAULT_EDITOR_OPTIONS: EditorProps["options"] = {
  minimap: { enabled: false },
  lineNumbers: "on",
  scrollBeyondLastLine: false,
  fontSize: 13,
  tabSize: 2,
  wordWrap: "on",
  wordBasedSuggestions: "off",
  quickSuggestions: false,
  padding: { top: 8, bottom: 8 },
  renderLineHighlight: "gutter",
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  scrollbar: {
    vertical: "auto",
    horizontal: "auto",
  },
};

export type TemplateCodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  language: string;
  disabled?: boolean;
  height?: string;
  placeholder?: string;
  /**
   * Replaces the default Monaco options wholesale (readOnly is still driven
   * by `disabled`). Lets variants keep their exact editor configuration.
   */
  editorOptions?: EditorProps["options"];
};

export function TemplateCodeEditor({
  value,
  onChange,
  language,
  disabled,
  height = "320px",
  placeholder,
  editorOptions,
}: TemplateCodeEditorProps): React.ReactElement {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const executionLogs = useAtomValue(executionLogsAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const workflowInputSchema = useAtomValue(currentWorkflowInputSchemaAtom);
  const lastExecutionLogs = useAtomValue(lastExecutionLogsAtom);
  const setLastExecutionLogs = useSetAtom(lastExecutionLogsAtom);

  const nodesRef = useStableRef(nodes);
  const edgesRef = useStableRef(edges);
  const selectedNodeRef = useStableRef(selectedNodeId);
  const executionLogsRef = useStableRef(executionLogs);
  const lastExecutionLogsRef = useStableRef(lastExecutionLogs);
  const currentWorkflowIdRef = useStableRef(currentWorkflowId);
  const workflowInputSchemaRef = useStableRef(workflowInputSchema);
  const lastFetchWorkflowIdRef = useRef<string | null>(null);

  const templateMapRef = useRef(new Map<string, string>());

  // biome-ignore lint/suspicious/noExplicitAny: Monaco editor types are complex and vary across versions
  const editorRef = useRef<any>(null);
  const decorationIdsRef = useRef<string[]>([]);

  const displayValue = useMemo(
    () => value.replace(/\{\{@[^:]+:([^}]+)\}\}/g, "{{$1}}"),
    [value]
  );

  useEffect(() => {
    const map = new Map<string, string>();
    const pattern = /\{\{@([^:]+):([^}]+)\}\}/g;
    for (const match of value.matchAll(pattern)) {
      map.set(match[2], match[1]);
    }
    templateMapRef.current = map;
  }, [value]);

  /**
   * Fallback: find a node ID by matching the label portion of a display key.
   * e.g. for "Manual.timestamp", extract "Manual" and find the node.
   * Reads only from nodesRef (stable ref), so no reactive deps needed.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodesRef is a stable ref; we read .current at call time intentionally
  const resolveNodeIdByLabel = useCallback(
    (displayKey: string): string | undefined => {
      const dotIndex = displayKey.indexOf(".");
      const label =
        dotIndex === -1 ? displayKey : displayKey.substring(0, dotIndex);
      const allNodes = nodesRef.current;
      for (const node of allNodes) {
        if (getNodeDisplayName(node) === label) {
          return node.id;
        }
      }
      return undefined;
    },
    []
  );

  const handleEditorChange = useCallback(
    (newDisplay: string) => {
      const stored = newDisplay.replace(
        /\{\{([^@}][^}]*)\}\}/g,
        (full: string, displayPart: string) => {
          const mappedId = templateMapRef.current.get(displayPart);
          if (mappedId) {
            return `{{@${mappedId}:${displayPart}}}`;
          }
          const foundId = resolveNodeIdByLabel(displayPart);
          if (foundId) {
            templateMapRef.current.set(displayPart, foundId);
            return `{{@${foundId}:${displayPart}}}`;
          }
          return full;
        }
      );
      onChange(stored);
    },
    [onChange, resolveNodeIdByLabel]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: currentWorkflowIdRef is a stable ref read at async resolution time, not a reactive dependency
  useEffect(() => {
    const alreadyHaveLogs = lastExecutionLogs.workflowId === currentWorkflowId;
    const fetchAlreadyInProgress =
      lastFetchWorkflowIdRef.current === currentWorkflowId;
    if (!currentWorkflowId || alreadyHaveLogs || fetchAlreadyInProgress) {
      return;
    }

    const workflowId = currentWorkflowId;
    lastFetchWorkflowIdRef.current = workflowId;
    let cancelled = false;

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: async fetch with cancellation guard mirrors template-autocomplete.tsx
    const fetchLogs = async (): Promise<void> => {
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
        const isStillRelevant =
          !cancelled && currentWorkflowIdRef.current === workflowId;
        if (isStillRelevant) {
          setLastExecutionLogs({ workflowId, logs: logsByNodeId });
        }
      } catch {
        // non-blocking
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
  }, [currentWorkflowId, lastExecutionLogs.workflowId, setLastExecutionLogs]);

  function getUpstreamNodes(): WorkflowNode[] {
    const nodeId = selectedNodeRef.current;
    if (!nodeId) {
      return [];
    }
    const allNodes = nodesRef.current;
    const allEdges = edgesRef.current;
    const visited = new Set<string>();
    const upstream: string[] = [];
    const traverse = (id: string): void => {
      if (visited.has(id)) {
        return;
      }
      visited.add(id);
      for (const edge of allEdges) {
        if (edge.target === id) {
          upstream.push(edge.source);
          traverse(edge.source);
        }
      }
    };
    traverse(nodeId);
    return allNodes.filter((n) => upstream.includes(n.id));
  }

  type Suggestion = {
    label: string;
    insertText: string;
    detail?: string;
    nodeId: string;
    field?: string;
  };

  function resolveNodeOutput(nodeId: string): unknown {
    const runtimeOutput = executionLogsRef.current[nodeId]?.output;
    if (runtimeOutput !== undefined && runtimeOutput !== null) {
      return runtimeOutput;
    }
    const lastLogs =
      lastExecutionLogsRef.current.workflowId === currentWorkflowIdRef.current
        ? lastExecutionLogsRef.current.logs
        : ({} as ExecutionLogsByNodeId);
    const lastRunOutput = lastLogs[nodeId]?.output;
    if (lastRunOutput !== undefined && lastRunOutput !== null) {
      return lastRunOutput;
    }
    return null;
  }

  function suggestionsFromOutput(
    node: WorkflowNode,
    nodeName: string,
    output: unknown
  ): Suggestion[] {
    const sanitizedId = sanitizeNodeId(node.id);
    const nodeOutputs: NodeOutputs = {
      [sanitizedId]: { label: nodeName, data: output },
    };
    const runtimeFields = getAvailableFields(nodeOutputs);
    const result: Suggestion[] = [];
    for (const entry of runtimeFields) {
      const fieldPath = entry.fieldPath || entry.field;
      if (!fieldPath) {
        continue;
      }
      const displayKey = `${nodeName}.${fieldPath}`;
      templateMapRef.current.set(displayKey, node.id);
      result.push({
        label: displayKey,
        insertText: `{{${displayKey}}}`,
        nodeId: node.id,
        field: fieldPath,
      });
    }
    return result;
  }

  function suggestionsFromStaticFields(
    node: WorkflowNode,
    nodeName: string
  ): Suggestion[] {
    const fields = getCommonFields(node);
    const result: Suggestion[] = [];
    for (const f of fields) {
      const displayKey = `${nodeName}.${f.field}`;
      templateMapRef.current.set(displayKey, node.id);
      result.push({
        label: displayKey,
        insertText: `{{${displayKey}}}`,
        detail: f.description,
        nodeId: node.id,
        field: f.field,
      });
    }
    return result;
  }

  function inputSchemaSuggestions(
    node: WorkflowNode,
    nodeName: string,
    existingFields: Set<string>
  ): Suggestion[] {
    if (node.data.type !== "trigger") {
      return [];
    }
    const schemaFields = getInputSchemaFields(workflowInputSchemaRef.current);
    if (schemaFields.length === 0) {
      return [];
    }
    const result: Suggestion[] = [];
    for (const f of schemaFields) {
      if (existingFields.has(f.field)) {
        continue;
      }
      const displayKey = `${nodeName}.${f.field}`;
      templateMapRef.current.set(displayKey, node.id);
      result.push({
        label: displayKey,
        insertText: `{{${displayKey}}}`,
        detail: f.description,
        nodeId: node.id,
        field: f.field,
      });
    }
    return result;
  }

  function buildSuggestions(): Suggestion[] {
    const upstreamNodes = getUpstreamNodes();
    const suggestions: Suggestion[] = [];

    for (const node of upstreamNodes) {
      const nodeName = getNodeDisplayName(node);
      const output = resolveNodeOutput(node.id);
      const nodeSuggestions =
        output !== null
          ? suggestionsFromOutput(node, nodeName, output)
          : suggestionsFromStaticFields(node, nodeName);
      suggestions.push(...nodeSuggestions);

      // Listed-workflow inputSchema fields (data.<fieldName>) are exposed for
      // trigger nodes regardless of whether a runtime execution captured them.
      const existing = new Set<string>();
      for (const s of nodeSuggestions) {
        if (s.field) {
          existing.add(s.field);
        }
      }
      suggestions.push(...inputSchemaSuggestions(node, nodeName, existing));
    }

    return suggestions;
  }

  const updateDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const model = editor.getModel();
    if (!model) {
      return;
    }

    const text = model.getValue();
    const templatePattern = /\{\{([^}]+)\}\}/g;
    // biome-ignore lint/suspicious/noExplicitAny: Monaco decoration types vary across versions
    const newDecorations: any[] = [];

    for (const match of text.matchAll(templatePattern)) {
      const start = model.getPositionAt(match.index);
      const end = model.getPositionAt(match.index + match[0].length);
      newDecorations.push({
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        options: {
          inlineClassName: "template-badge",
          hoverMessage: { value: `Template: ${match[1]}` },
        },
      });
    }

    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      newDecorations
    );
  }, []);

  useEffect(() => {
    updateDecorations();
  }, [updateDecorations]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: buildSuggestions reads from refs to always get current state; adding it would cause Monaco to re-mount on every render
  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      updateDecorations();

      let decorationRaf: number | undefined;
      editor.onDidChangeModelContent(() => {
        if (decorationRaf !== undefined) {
          cancelAnimationFrame(decorationRaf);
        }
        decorationRaf = requestAnimationFrame(() => {
          decorationRaf = undefined;
          updateDecorations();
        });
      });

      const disposable = monaco.languages.registerCompletionItemProvider(
        language,
        {
          triggerCharacters: ["@"],
          provideCompletionItems: (
            model: ReturnType<Monaco["editor"]["createModel"]>,
            position: { lineNumber: number; column: number }
          ) => {
            if (model !== editorRef.current?.getModel()) {
              return { suggestions: [] };
            }

            const textUntilPosition = model.getValueInRange({
              startLineNumber: position.lineNumber,
              startColumn: 1,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            });

            const atIndex = findActiveAtIndex(textUntilPosition);
            if (atIndex === -1) {
              return { suggestions: [] };
            }

            const range = {
              startLineNumber: position.lineNumber,
              startColumn: atIndex + 1,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            };

            const items = buildSuggestions();
            const suggestions = items.map((item) => ({
              label: item.label,
              kind: monaco.languages.CompletionItemKind.Variable,
              insertText: item.insertText,
              detail: item.detail || "",
              range,
              filterText: `@${item.label}`,
              sortText: `0-${item.label}`,
            }));

            return { suggestions };
          },
        }
      );

      editor.onDidDispose(() => {
        disposable.dispose();
      });
    },
    [language, updateDecorations]
  );

  const duplicateLabelWarnings = useMemo(
    () => findDuplicateTemplateLabels(displayValue, nodes),
    [displayValue, nodes]
  );

  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <CodeEditor
          defaultLanguage={language}
          defaultValue={placeholder}
          height={height}
          onChange={(v) => handleEditorChange(v || "")}
          onMount={handleMount}
          options={{
            ...(editorOptions ?? DEFAULT_EDITOR_OPTIONS),
            readOnly: disabled,
          }}
          value={displayValue}
        />
      </div>
      {duplicateLabelWarnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2 text-xs text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Multiple nodes share the label{" "}
            {duplicateLabelWarnings.map((label, i) => (
              <span key={label}>
                {i > 0 && ", "}
                <strong>{label}</strong>
              </span>
            ))}
            . Rename nodes to unique labels to ensure correct value resolution.
          </span>
        </div>
      )}
    </>
  );
}
