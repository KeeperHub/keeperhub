import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import {
  hasNoInAppFrames,
  isBrowserExtensionError,
  isEip1193ProviderRejection,
  isMonacoCancellation,
  throwsOutsideAppBundle,
} from "@/lib/sentry-filters";

// Minimal shape the filter predicates actually read. Cast to ErrorEvent so we
// don't have to spell out the dozens of fields the SDK accepts at runtime.
type TestEvent = {
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { type?: string; handled?: boolean };
      stacktrace?: {
        frames?: Array<{
          in_app?: boolean;
          filename?: string;
          abs_path?: string;
        }>;
      };
    }>;
  };
  extra?: Record<string, unknown>;
};

function makeEvent(partial: TestEvent): ErrorEvent {
  return partial as ErrorEvent;
}

describe("isEip1193ProviderRejection", () => {
  it("matches a rejection that carries a serialized provider error", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            mechanism: {
              type: "auto.browser.global_handlers.onunhandledrejection",
              handled: false,
            },
          },
        ],
      },
      extra: {
        __serialized__: { code: 4001, message: "User rejected the request" },
      },
    });
    expect(isEip1193ProviderRejection(event)).toBe(true);
  });

  it("ignores non-unhandledrejection events", () => {
    const event = makeEvent({
      exception: {
        values: [{ mechanism: { type: "onerror", handled: false } }],
      },
      extra: { __serialized__: { code: 1, message: "x" } },
    });
    expect(isEip1193ProviderRejection(event)).toBe(false);
  });

  it("ignores events without a serialized record", () => {
    const event = makeEvent({
      exception: {
        values: [
          { mechanism: { type: "onunhandledrejection", handled: false } },
        ],
      },
    });
    expect(isEip1193ProviderRejection(event)).toBe(false);
  });

  it("ignores events whose serialized record is not the EIP-1193 shape", () => {
    const event = makeEvent({
      exception: {
        values: [
          { mechanism: { type: "onunhandledrejection", handled: false } },
        ],
      },
      extra: { __serialized__: { foo: "bar" } },
    });
    expect(isEip1193ProviderRejection(event)).toBe(false);
  });
});

describe("hasNoInAppFrames", () => {
  it("returns true when every frame is out-of-app", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { in_app: false, filename: "injected.js" },
                { in_app: false, filename: "injectedScript.bundle.js" },
              ],
            },
          },
        ],
      },
    });
    expect(hasNoInAppFrames(event)).toBe(true);
  });

  it("returns false when at least one frame is in-app", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { in_app: false, filename: "injected.js" },
                { in_app: true, filename: "app/page.tsx" },
              ],
            },
          },
        ],
      },
    });
    expect(hasNoInAppFrames(event)).toBe(false);
  });

  it("returns false when there are no frames", () => {
    const event = makeEvent({ exception: { values: [{}] } });
    expect(hasNoInAppFrames(event)).toBe(false);
  });
});

describe("isBrowserExtensionError", () => {
  it("matches when a frame's filename is the wallet extension service worker", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            mechanism: {
              type: "auto.browser.browserapierrors.addEventListener",
              handled: false,
            },
            stacktrace: {
              frames: [
                {
                  in_app: true,
                  filename: "app:///extensionServiceWorker.js",
                },
              ],
            },
          },
        ],
      },
    });
    expect(isBrowserExtensionError(event)).toBe(true);
  });

  it("matches when a frame's abs_path uses the chrome-extension protocol", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  in_app: true,
                  filename: "app:///inpage.js",
                  abs_path:
                    "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js",
                },
              ],
            },
          },
        ],
      },
    });
    expect(isBrowserExtensionError(event)).toBe(true);
  });

  it("matches firefox moz-extension abs_paths", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  in_app: true,
                  filename: "app:///inpage.js",
                  abs_path: "moz-extension://abc/inpage.js",
                },
              ],
            },
          },
        ],
      },
    });
    expect(isBrowserExtensionError(event)).toBe(true);
  });

  it("does not match plain app frames", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  in_app: true,
                  filename: "app:///app/workflows/[workflowId]/page.tsx",
                  abs_path: "https://app.keeperhub.com/workflows/x",
                },
              ],
            },
          },
        ],
      },
    });
    expect(isBrowserExtensionError(event)).toBe(false);
  });

  it("does not match when there are no frames", () => {
    const event = makeEvent({ exception: { values: [{}] } });
    expect(isBrowserExtensionError(event)).toBe(false);
  });
});

describe("throwsOutsideAppBundle", () => {
  function eventWithFrames(filenames: string[]): ErrorEvent {
    return makeEvent({
      exception: {
        values: [
          {
            type: "TypeError",
            mechanism: {
              type: "auto.browser.global_handlers.onerror",
              handled: false,
            },
            stacktrace: {
              frames: filenames.map((filename) => ({ in_app: true, filename })),
            },
          },
        ],
      },
    });
  }

  // Injectors seen in production. Sentry rewrote every one of these to our own
  // origin, which is why the in-app checks let them through.
  const injectedFilenames = [
    "app:///welcome:1:19",
    "app:///hub:1:592482",
    "app:///window-provider.js:520:122",
    "app:///scripts/inject.js:1:20071",
    "app:///injectedScript.bundle.js:2:94489",
  ];

  for (const filename of injectedFilenames) {
    it(`drops a throw from ${filename}`, () => {
      expect(throwsOutsideAppBundle(eventWithFrames([filename]))).toBe(true);
    });
  }

  it("drops a document throw even when the SDK wrapper frame is ours", () => {
    const event = eventWithFrames([
      "app:///_next/static/chunks/main-0000.js:6:1332",
      "app:///hub:1:592482",
    ]);
    expect(throwsOutsideAppBundle(event)).toBe(true);
  });

  it("keeps a throw from our own bundle", () => {
    const event = eventWithFrames([
      "app:///_next/static/chunks/framework-0000.js:20:198900",
      "app:///_next/static/chunks/page-0000.js:2:71984",
    ]);
    expect(throwsOutsideAppBundle(event)).toBe(false);
  });

  it("keeps an event whose throwing frame has no filename", () => {
    const event = makeEvent({
      exception: { values: [{ stacktrace: { frames: [{ in_app: true }] } }] },
    });
    expect(throwsOutsideAppBundle(event)).toBe(false);
  });

  it("keeps an event with no frames", () => {
    const event = makeEvent({ exception: { values: [{}] } });
    expect(throwsOutsideAppBundle(event)).toBe(false);
  });

  // Linked errors, as produced by auto.core.linked_errors, split the thrown
  // error and its cause across separate exception values.
  it("drops linked errors when every value is third party", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ in_app: true, filename: "app:///scripts/inpage.js" }],
            },
          },
          {
            stacktrace: {
              frames: [
                { in_app: true, filename: "app:///scripts/inpage.js:4:41709" },
              ],
            },
          },
        ],
      },
    });
    expect(throwsOutsideAppBundle(event)).toBe(true);
  });

  it("keeps linked errors when one value is ours", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ in_app: true, filename: "app:///scripts/inpage.js" }],
            },
          },
          {
            stacktrace: {
              frames: [
                {
                  in_app: true,
                  filename: "app:///_next/static/chunks/page-0000.js",
                },
              ],
            },
          },
        ],
      },
    });
    expect(throwsOutsideAppBundle(event)).toBe(false);
  });
});

describe("isMonacoCancellation", () => {
  it("matches an unhandled rejection with type and value 'Canceled'", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            type: "Canceled",
            value: "Canceled",
            mechanism: {
              type: "auto.browser.global_handlers.onunhandledrejection",
              handled: false,
            },
          },
        ],
      },
    });
    expect(isMonacoCancellation(event)).toBe(true);
  });

  it("does not match when the mechanism is not unhandledrejection", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            type: "Canceled",
            value: "Canceled",
            mechanism: { type: "onerror", handled: false },
          },
        ],
      },
    });
    expect(isMonacoCancellation(event)).toBe(false);
  });

  it("does not match when only value is 'Canceled' but type is something else", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            type: "Error",
            value: "Canceled",
            mechanism: { type: "onunhandledrejection", handled: false },
          },
        ],
      },
    });
    expect(isMonacoCancellation(event)).toBe(false);
  });

  it("does not match unrelated cancellation messages", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            type: "AbortError",
            value: "The user aborted a request.",
            mechanism: { type: "onunhandledrejection", handled: false },
          },
        ],
      },
    });
    expect(isMonacoCancellation(event)).toBe(false);
  });

  it("does not match an empty exception", () => {
    const event = makeEvent({});
    expect(isMonacoCancellation(event)).toBe(false);
  });
});
