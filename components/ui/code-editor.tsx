"use client";

import type { EditorProps } from "@monaco-editor/react";
import dynamic from "next/dynamic";

// Shared configuration panels import this component even when no editor is
// mounted. Keep Monaco and its workers behind the rendered editor boundary.
export const CodeEditor = dynamic<EditorProps>(
  async () => {
    const [{ CodeEditorImplementation }, { configureMonaco }] = await Promise.all([
      import("./code-editor-implementation"),
      import("@/lib/monaco-loader-config"),
    ]);
    // The React wrapper calls loader.init() on mount. Configure the bundled
    // Monaco first so it cannot race into the loader's default CDN fallback.
    await configureMonaco();
    return CodeEditorImplementation;
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-24 items-center justify-center text-muted-foreground text-sm" role="status">
        Loading editor…
      </div>
    ),
  }
);
