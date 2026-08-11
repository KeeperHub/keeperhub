"use client";

import "@/lib/monaco-loader-config";

import MonacoEditor, { type EditorProps, type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { useCallback, useMemo } from "react";
import { vercelDarkTheme } from "@/lib/monaco-theme";

let overflowWidgetsDomNode: HTMLElement | null = null;

function getOverflowWidgetsDomNode(): HTMLElement | undefined {
  if (typeof document === "undefined") {
    return;
  }
  if (overflowWidgetsDomNode) {
    return overflowWidgetsDomNode;
  }
  const node = document.createElement("div");
  node.className = "monaco-editor monaco-editor-overflow-widgets-root";
  node.style.position = "absolute";
  node.style.top = "0";
  node.style.left = "0";
  node.style.width = "0";
  node.style.height = "0";
  node.style.zIndex = "10000";
  document.body.appendChild(node);
  overflowWidgetsDomNode = node;
  return node;
}

export function CodeEditor(props: EditorProps): React.ReactElement {
  const { resolvedTheme } = useTheme();
  const propsOnMount = props.onMount;

  const mergedOptions = useMemo(
    () => ({
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: getOverflowWidgetsDomNode(),
      ...props.options,
    }),
    [props.options]
  );

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      monaco.editor.defineTheme("vercel-dark", vercelDarkTheme);
      monaco.editor.setTheme(resolvedTheme === "dark" ? "vercel-dark" : "light");

      const node = editor.getDomNode();
      if (node) {
        const observer = new ResizeObserver(() => {
          editor.layout();
        });
        observer.observe(node);
        editor.onDidDispose(() => {
          observer.disconnect();
        });
      }

      if (propsOnMount) {
        propsOnMount(editor, monaco);
      }
    },
    [propsOnMount, resolvedTheme]
  );

  return (
    <MonacoEditor
      {...props}
      onMount={handleEditorMount}
      options={mergedOptions}
      theme={resolvedTheme === "dark" ? "vercel-dark" : "light"}
    />
  );
}
