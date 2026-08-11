/**
 * Global event-based sidebar refetch system
 *
 * Allows any part of the app to trigger a refetch of sidebar data
 * (workflows, projects, tags) without direct access to React hooks.
 */

type RefetchOptions = {
  closeFlyout?: boolean;
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
