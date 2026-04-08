/**
 * Async-local error context for workflow error logs.
 *
 * Carries org/owner/workflow identifiers across async boundaries so that
 * downstream calls to logUserError/logSystemError automatically pick them up.
 *
 * IMPORTANT: this module is reachable from `workflow-executor.workflow.ts`,
 * which is bundled by the Workflow DevKit and forbids any Node.js builtins.
 * It therefore contains zero static `node:` imports. The actual
 * AsyncLocalStorage instance is registered at server startup from
 * `instrumentation.ts` via `setWorkflowErrorContextStorage`. Inside the
 * Workflow DevKit runtime no storage is registered and every function
 * degrades to a no-op - callers must thread labels explicitly there.
 */

export type WorkflowErrorContext = {
  workflow_id?: string;
  execution_id?: string;
  org_id?: string;
  org_slug?: string;
  owner_id?: string;
  plugin_id?: string;
  integration_id?: string;
};

export type WorkflowErrorContextStorage = {
  getStore(): WorkflowErrorContext | undefined;
  run<T>(ctx: WorkflowErrorContext, fn: () => T): T;
  enterWith(ctx: WorkflowErrorContext): void;
};

let storage: WorkflowErrorContextStorage | null = null;

/**
 * Register the AsyncLocalStorage instance. Called from `instrumentation.ts`
 * at server startup so that the Node-only `node:async_hooks` import never
 * appears in the workflow runtime bundle.
 */
export function setWorkflowErrorContextStorage(
  s: WorkflowErrorContextStorage
): void {
  storage = s;
}

export function runWithWorkflowErrorContext<T>(
  ctx: WorkflowErrorContext,
  fn: () => T
): T {
  if (!storage) {
    return fn();
  }
  const outer = storage.getStore();
  const merged: WorkflowErrorContext = { ...outer, ...stripUndefined(ctx) };
  return storage.run(merged, fn);
}

export function getWorkflowErrorContext(): WorkflowErrorContext | undefined {
  return storage?.getStore();
}

/**
 * Set the workflow error context for the remainder of the current async
 * chain without requiring a callback. No-op when no storage is registered
 * (e.g. inside the Workflow DevKit runtime).
 */
export function enterWorkflowErrorContext(ctx: WorkflowErrorContext): void {
  if (!storage) {
    return;
  }
  const outer = storage.getStore();
  const merged: WorkflowErrorContext = { ...outer, ...stripUndefined(ctx) };
  storage.enterWith(merged);
}

function stripUndefined(ctx: WorkflowErrorContext): WorkflowErrorContext {
  const out: WorkflowErrorContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined && v !== null && v !== "") {
      (out as Record<string, string>)[k] = v;
    }
  }
  return out;
}
