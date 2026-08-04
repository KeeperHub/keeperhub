// Onboarding tours are suppressed when this cookie is present. Playwright sets
// it by default (see tests/e2e/playwright/fixtures.ts) so the driver.js overlay
// never blocks unrelated tests; the onboarding tests opt out to exercise them.
const DISABLE_TOURS_COOKIE = "kh_disable_tours=1";

// The first-run "Get started" launcher auto-expands into a card that overhangs
// the sidebar onto the canvas, where it intercepts clicks on workflow nodes.
// Playwright sets this cookie by default (see tests/e2e/playwright/fixtures.ts)
// so the launcher stays collapsed; the getting-started tests opt out.
const DISABLE_GETTING_STARTED_COOKIE = "kh_disable_gs=1";

export function toursDisabled(): boolean {
  return (
    typeof document !== "undefined" &&
    document.cookie.includes(DISABLE_TOURS_COOKIE)
  );
}

/** Whether the getting-started launcher should skip its first-run auto-expand. */
export function gettingStartedSuppressed(): boolean {
  return (
    typeof document !== "undefined" &&
    document.cookie.includes(DISABLE_GETTING_STARTED_COOKIE)
  );
}
