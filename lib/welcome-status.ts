// Client-only flags that drive the welcome experience. These are onboarding UX
// only -- not a security gate -- so localStorage is sufficient, mirroring the
// getting-started guide's `keeperhub-onboarding-guide` persistence pattern.

const CONTINUE_AS_GUEST_KEY = "keeperhub-continue-as-guest";

function readFlag(key: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private-mode / storage-disabled: the flow still works, the wall just
    // re-shows on reload. Nothing to recover here.
  }
}

/**
 * Persists onboarding completion server-side (the authoritative flag, read on
 * every session fetch) so the wizard is not shown again on any device. Resolves
 * even on failure so callers can await it before navigating.
 */
export async function markOnboardingComplete(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  try {
    await fetch("/api/user/onboarding/complete", { method: "POST" });
  } catch {
    // Best-effort; the caller still navigates and the gate re-shows if needed.
  }
}

/** True once the user chose "Continue without an account" on the welcome page. */
export function isContinueAsGuest(): boolean {
  return readFlag(CONTINUE_AS_GUEST_KEY);
}

export function markContinueAsGuest(): void {
  writeFlag(CONTINUE_AS_GUEST_KEY);
}
