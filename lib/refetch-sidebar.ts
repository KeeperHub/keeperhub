import { triggerDisplayKey } from "@/lib/workflow/trigger-display-key";

/**
 * Global event-based sidebar refetch system
 *
 * Allows any part of the app to trigger a refetch of sidebar data
 * (workflows, projects, tags) without direct access to React hooks.
 */

type RefetchOptions = {
  closeFlyout?: boolean;
  // The active organization changed: a list that fails to load must not
  // leave the previous organization's workflows on screen.
  orgChanged?: boolean;
};

type RefetchCallback = (options?: RefetchOptions) => void;

const refetchCallbacks: Set<RefetchCallback> = new Set();
let pendingOptions: RefetchOptions | null = null;

/**
 * Register a refetch callback (called from NavigationSidebar).
 * Replays any pending refetch that fired before registration.
 */
export function registerSidebarRefetch(callback: RefetchCallback): () => void {
  refetchCallbacks.add(callback);

  if (pendingOptions !== null) {
    const opts = pendingOptions;
    pendingOptions = null;
    try {
      callback(opts);
    } catch {
      /* ignore replay errors */
    }
  }

  return () => {
    refetchCallbacks.delete(callback);
  };
}

/**
 * Trigger all registered sidebar refetch callbacks.
 * Call this after org switch, project/tag changes, or any action
 * that changes sidebar data. Queues the call if no callbacks are
 * registered yet, replaying when the first one registers.
 */
export function refetchSidebar(options?: RefetchOptions): void {
  if (refetchCallbacks.size === 0) {
    pendingOptions = options ?? {};
    return;
  }
  for (const callback of refetchCallbacks) {
    try {
      callback(options);
    } catch {
      /* ignore callback errors */
    }
  }
}

// What each workflow's sidebar row showed for its trigger at its last save.
const savedTriggers = new Map<string, string>();

type NodeLike = { data?: { type?: string; config?: unknown } };

/**
 * Refetch the sidebar after a save that changes what a workflow's row shows
 * for its trigger (type, schedule, event, block interval), so the row follows
 * it. Edits the row does not show (an ABI, a webhook schema) do not refetch.
 * The first save of a workflow in a session has nothing to compare to and
 * refetches once.
 */
export function refetchSidebarIfTriggerChanged(
  workflowId: string,
  nodes: NodeLike[]
): void {
  const trigger = triggerDisplayKey(
    nodes.find((node) => node.data?.type === "trigger")?.data?.config
  );
  if (savedTriggers.get(workflowId) === trigger) {
    return;
  }
  savedTriggers.set(workflowId, trigger);
  refetchSidebar();
}
