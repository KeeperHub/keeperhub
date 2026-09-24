"use client";

import { toast } from "sonner";

/**
 * Surface a policy refusal wherever it happens.
 *
 * A refusal is a 403 like any other as far as a caller is concerned, so every
 * call site would otherwise have to recognise one and say so. There are far too
 * many for that to hold: most mutations in this app call `fetch` directly rather
 * than going through the API client, and a new one added tomorrow would be
 * silent again. So this wraps `fetch` once, for the same reason the server wraps
 * the resolvers rather than each route: feedback becomes a property of the
 * request rather than of whether the caller remembered.
 *
 * It only reads. The response is cloned before its body is touched, the original
 * is returned untouched, and a failure to parse is ignored, so a page behaves
 * exactly as it would without this installed.
 */

/** The code the API envelope carries for a refusal. */
const POLICY_DENIED = "policy_denied";

/** Long enough to read a sentence and follow the link. */
const TOAST_MS = 8000;

/**
 * One action can fan out into several requests, and a refusal usually stops all
 * of them the same way. Showing one toast per request would bury the page.
 */
const REPEAT_WINDOW_MS = 3000;

/** The link the server appends to a refusal message. */
const URL_IN_MESSAGE = /https?:\/\/\S+/;
/** Trailing punctuation a sentence leaves on the end of a URL. */
const TRAILING_PUNCTUATION = /[.,)]+$/;
/** The dangling "at" left behind once the URL is lifted out of the sentence. */
const DANGLING_AT = /\s+at$/;

type Envelope = {
  error?: unknown;
  detail?: unknown;
};

let installed = false;

/** A same-origin call into our own API, which is the only thing policy governs. */
function isOwnApiRequest(url: string): boolean {
  try {
    const resolved = new URL(url, window.location.origin);
    return (
      resolved.origin === window.location.origin &&
      resolved.pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/**
 * The link the server put in the message, so the toast can offer it as
 * somewhere to go rather than as text nobody can click.
 */
function extractLink(message: string): { text: string; href: string | null } {
  const match = message.match(URL_IN_MESSAGE);
  if (!match) {
    return { text: message, href: null };
  }
  const href = match[0].replace(TRAILING_PUNCTUATION, "");
  return {
    text: message.replace(match[0], "").trim().replace(DANGLING_AT, ""),
    href,
  };
}

let lastShownAt = 0;
let lastMessage = "";

function announce(message: string): void {
  const now = Date.now();
  if (message === lastMessage && now - lastShownAt < REPEAT_WINDOW_MS) {
    return;
  }
  lastShownAt = now;
  lastMessage = message;

  const { text, href } = extractLink(message);
  toast.error(text || "Blocked by an organization policy.", {
    duration: TOAST_MS,
    action: href
      ? {
          label: "View policies",
          onClick: () => {
            window.location.href = href;
          },
        }
      : undefined,
  });
}

/** Read the envelope without disturbing the response the caller will read. */
async function refusalMessage(response: Response): Promise<string | null> {
  if (response.status !== 403) {
    return null;
  }
  try {
    const body = (await response.clone().json()) as Envelope;
    if (body.error !== POLICY_DENIED) {
      return null;
    }
    return typeof body.detail === "string" && body.detail.trim() !== ""
      ? body.detail
      : "Blocked by an organization policy.";
  } catch {
    // Not JSON, or already consumed. A refusal we cannot read is not worth
    // breaking the page over.
    return null;
  }
}

/**
 * Install the listener. Safe to call more than once; only the first call wraps
 * `fetch`, so a remount does not stack wrappers.
 */
export function installPolicyDenialListener(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;

  const original = window.fetch;
  window.fetch = async function policyAwareFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const response = await original.call(window, input, init);
    if (!isOwnApiRequest(requestUrl(input))) {
      return response;
    }
    const message = await refusalMessage(response);
    if (message) {
      announce(message);
    }
    return response;
  };
}
