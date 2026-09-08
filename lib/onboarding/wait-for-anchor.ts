// Tour anchors (the Sign In button, editor controls) mount after their owning
// component resolves session/route state, so an anchor can be absent for a tick
// when a tour wants to highlight it. Resolve once it appears, or null if it
// never shows within the timeout / the caller aborts. Shared by every tour.
export function waitForAnchor(
  selector: string,
  signal: AbortSignal,
  timeoutMs = 5000
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    // The abort event fires once when the signal transitions from not-aborted
    // to aborted. Adding a listener after that point never fires it, so check
    // upfront. Without this, a component that unmounts before waitForAnchor
    // runs waits the full timeoutMs (up to 120 s in create-wallet paths).
    if (signal.aborted) {
      resolve(null);
      return;
    }

    const existing = document.querySelector<HTMLElement>(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    let observer: MutationObserver;
    let timeoutId: number;
    let settled = false;

    const finish = (element: HTMLElement | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeoutId);
      resolve(element);
    };

    observer = new MutationObserver(() => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) {
        finish(element);
      }
    });
    timeoutId = window.setTimeout(() => {
      finish(null);
    }, timeoutMs);

    signal.addEventListener("abort", () => finish(null), { once: true });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
