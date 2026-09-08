// Predicates used by Sentry's beforeSend hook to drop benign or
// unactionable events at ingest. Kept in their own module so they can be
// unit-tested without re-running Sentry's init() side effects.

import type { ErrorEvent } from "@sentry/nextjs";

// Wallet providers (EIP-1193) reject with plain `{ code, message }` objects
// rather than Error instances, producing unhandled rejections with no stack.
// These are not actionable, so drop them at ingest.
export function isEip1193ProviderRejection(event: ErrorEvent): boolean {
  const mechanismType = event.exception?.values?.[0]?.mechanism?.type;
  if (!mechanismType?.includes("onunhandledrejection")) {
    return false;
  }
  const serialized = (event.extra as { __serialized__?: unknown } | undefined)
    ?.__serialized__;
  if (!serialized || typeof serialized !== "object") {
    return false;
  }
  const asRecord = serialized as Record<string, unknown>;
  return (
    typeof asRecord.code === "number" && typeof asRecord.message === "string"
  );
}

// Browser extensions (wallet shims, ad blockers, etc.) inject scripts into the
// page and throw errors that surface to window.onerror. They show up in Sentry
// with stacktraces composed entirely of non-app frames (`injected.js`,
// `injectedScript.bundle.js`, vendor shims). Drop events where the SDK marked
// every frame as out-of-app — they're third-party noise we can't fix.
export function hasNoInAppFrames(event: ErrorEvent): boolean {
  const frames = event.exception?.values?.[0]?.stacktrace?.frames;
  if (!frames || frames.length === 0) {
    return false;
  }
  return !frames.some((frame) => frame.in_app === true);
}

// Browser wallet extensions (MetaMask and forks) bundle a service worker that
// throws "Attempting to use a disconnected port object" when their
// `chrome.runtime.Port` to the page detaches mid-message. Sentry's
// `browserApiErrors` integration wraps `addEventListener` and surfaces these
// as in-app errors because Sentry's frame normalizer rewrites the original
// `chrome-extension://<id>/...` URL to `app:///...`, defeating
// `hasNoInAppFrames`. Match on the rewritten filename or the original
// extension-protocol abs_path so we drop them at ingest.
const EXTENSION_FILENAME_PATTERN = /extensionServiceWorker\.js$/;
const EXTENSION_PROTOCOL_PATTERN =
  /^(?:chrome|moz|safari|safari-web)-extension:\/\//;

export function isBrowserExtensionError(event: ErrorEvent): boolean {
  const frames = event.exception?.values?.[0]?.stacktrace?.frames;
  if (!frames || frames.length === 0) {
    return false;
  }
  return frames.some((frame) => {
    const filename = frame.filename;
    const absPath = (frame as { abs_path?: string }).abs_path;
    return (
      (typeof filename === "string" &&
        EXTENSION_FILENAME_PATTERN.test(filename)) ||
      (typeof absPath === "string" && EXTENSION_PROTOCOL_PATTERN.test(absPath))
    );
  });
}

// Our own JavaScript is only ever served from `/_next/static/`. Wallet
// providers and browser shims run either from an extension origin or from a
// script injected into the document, and Sentry's normalizer rewrites both to
// `app:///...`, which marks them in-app and slips them past `hasNoInAppFrames`.
// Judge the frame the error actually threw from, the last one, so any injected
// third party is dropped without enumerating provider names.
const APP_BUNDLE_PATTERN = /\/_next\/static\//;

export function throwsOutsideAppBundle(event: ErrorEvent): boolean {
  const values = event.exception?.values;
  if (!values || values.length === 0) {
    return false;
  }
  // Linked errors carry the cause and the thrown error as separate values, so
  // require every one of them to be third party. An error of ours that merely
  // has a third-party cause stays reportable.
  return values.every((value) => {
    const frames = value.stacktrace?.frames;
    if (!frames || frames.length === 0) {
      return false;
    }
    const filename = frames.at(-1)?.filename;
    return typeof filename === "string" && !APP_BUNDLE_PATTERN.test(filename);
  });
}

// `@monaco-editor/react` rejects with a `CancellationError` ("Canceled") when
// its loader/dispose chain unwinds before the editor finishes mounting — for
// example when the user navigates away from `/workflows/:workflowId` quickly.
// The rejection is benign (the editor is already gone) but bubbles to
// `window.onunhandledrejection` and pollutes Sentry. Filter it out at ingest.
export function isMonacoCancellation(event: ErrorEvent): boolean {
  const exception = event.exception?.values?.[0];
  const mechanismType = exception?.mechanism?.type;
  if (!mechanismType?.includes("onunhandledrejection")) {
    return false;
  }
  return exception?.value === "Canceled" && exception?.type === "Canceled";
}
