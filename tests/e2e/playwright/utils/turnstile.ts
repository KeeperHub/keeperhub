import type { Page } from "@playwright/test";

/**
 * Deterministically satisfy the signup Cloudflare Turnstile challenge.
 *
 * The signup "Create account" button is disabled until the Turnstile widget
 * produces a token (components/auth/dialog.tsx: `disabled={loading ||
 * (!!turnstileSiteKey && !captchaToken)}`). The real widget is loaded from
 * challenges.cloudflare.com and only resolves interactively, so in the headless
 * CI runner it never issues a token and every UI-signup test hangs on the
 * disabled button until the 60s timeout. The server-side captcha gate is already
 * bypassed in CI (lib/auth.ts under CI=true), so any client token unblocks the
 * flow; this stub supplies one without the network round-trip.
 *
 * Installs a `window.turnstile` shim that immediately invokes the success
 * callback `@marsidev/react-turnstile` passes to `render()`, and serves an empty
 * body for the real api.js so the library's load gate resolves without the live
 * script overwriting the shim (and without firing an onError that would clear
 * the token). Call before the first navigation that may render the auth dialog.
 */
export async function stubTurnstile(page: Page): Promise<void> {
  await page.route("**/turnstile/v0/api.js**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "",
    })
  );

  await page.addInitScript(() => {
    const TOKEN = "e2e-turnstile-stub-token";
    const widgets = new Map<string, { callback?: (token: string) => void }>();
    let counter = 0;

    const fireSuccess = (id: string): void => {
      const params = widgets.get(id);
      if (params?.callback) {
        Promise.resolve().then(() => params.callback?.(TOKEN));
      }
    };

    (window as unknown as { turnstile: unknown }).turnstile = {
      render(_container: unknown, params: { callback?: (t: string) => void }) {
        const id = `turnstile-stub-${counter++}`;
        widgets.set(id, params);
        fireSuccess(id);
        return id;
      },
      reset(id?: string) {
        if (id) {
          fireSuccess(id);
        }
      },
      remove(id?: string) {
        if (id) {
          widgets.delete(id);
        }
      },
      execute(id?: string) {
        if (id) {
          fireSuccess(id);
        }
      },
      getResponse() {
        return TOKEN;
      },
      isExpired() {
        return false;
      },
    };
  });
}
