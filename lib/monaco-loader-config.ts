import { loader } from "@monaco-editor/react";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(workerId: string, label: string): Worker;
    };
  }
}

// monaco-editor 0.56 added an `exports` map ("./*": "./esm/vs/*.js") that makes
// the `esm/vs/` prefix implicit, so the old deep specifiers now resolve to
// `esm/vs/esm/vs/...` and fail to bundle. These paths target the same worker
// files as before, spelled for the exports map.
async function initializeMonaco(): Promise<void> {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === "json") {
        return new Worker(
          new URL(
            "monaco-editor/language/json/json.worker.js",
            import.meta.url
          ),
          { type: "module" }
        );
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(
          new URL("monaco-editor/language/css/css.worker.js", import.meta.url),
          { type: "module" }
        );
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(
          new URL(
            "monaco-editor/language/html/html.worker.js",
            import.meta.url
          ),
          { type: "module" }
        );
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(
          new URL(
            "monaco-editor/language/typescript/ts.worker.js",
            import.meta.url
          ),
          { type: "module" }
        );
      }
      return new Worker(
        new URL("monaco-editor/editor/editor.worker.js", import.meta.url),
        { type: "module" }
      );
    },
  };

  const monaco = await import("monaco-editor");
  loader.config({ monaco });
}

let initialization: Promise<void> | undefined;

export function configureMonaco(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  if (!initialization) {
    initialization = initializeMonaco().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}
