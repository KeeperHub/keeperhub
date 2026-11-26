const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const LOAD_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

type TurnstileRenderOptions = {
  sitekey: string;
  appearance: "interaction-only";
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
};

function readTurnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

function loadTurnstileApi(): Promise<TurnstileApi> {
  const loaded = readTurnstileApi();
  if (loaded) {
    return Promise.resolve(loaded);
  }
  if (!document.getElementById(SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    document.head.append(script);
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const api = readTurnstileApi();
      if (api) {
        window.clearInterval(timer);
        resolve(api);
      } else if (Date.now() - startedAt > LOAD_TIMEOUT_MS) {
        window.clearInterval(timer);
        reject(new Error("Could not load the security check."));
      }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Solves a Turnstile challenge without a visible widget. Cloudflare shows the
 * challenge only when it needs the user to interact. Returns undefined when no
 * site key is configured (local dev), where the server does not require one.
 */
export async function getTurnstileToken(): Promise<string | undefined> {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (!siteKey) {
    return;
  }
  const api = await loadTurnstileApi();
  const container = document.createElement("div");
  container.className = "fixed bottom-4 left-1/2 z-50 -translate-x-1/2";
  document.body.append(container);

  return new Promise((resolve, reject) => {
    let widgetId: string | undefined;
    const finish = (): void => {
      if (widgetId) {
        api.remove(widgetId);
      }
      container.remove();
    };
    const fail = (): void => {
      finish();
      reject(new Error("The security check failed. Please try again."));
    };
    widgetId = api.render(container, {
      sitekey: siteKey,
      appearance: "interaction-only",
      callback: (token: string) => {
        finish();
        resolve(token);
      },
      "error-callback": fail,
      "expired-callback": fail,
      "timeout-callback": fail,
    });
  });
}

/** Fetch options carrying a Turnstile token for a captcha-gated auth call. */
export async function captchaFetchOptions(): Promise<
  { headers: Record<string, string> } | undefined
> {
  const token = await getTurnstileToken();
  return token ? { headers: { "x-captcha-response": token } } : undefined;
}
