/**
 * Unit tests for PendingScanRunner — FUNNEL-03/04 runner behaviour.
 *
 * RED scaffold (Wave 0, Plan 54-01). All tests fail against the throw-stub;
 * they turn GREEN when the real implementation lands in Plan 54-03.
 *
 * Test environment: node (vitest default). `window` is stubbed globally via
 * vi.stubGlobal to simulate the browser addEventListener surface. The React
 * hooks (useEffect, useRef, useRouter) are mocked so the component's effect
 * function can be captured and driven without jsdom.
 *
 * Coverage (FUNNEL-03/04):
 *   - The component registers a kh:auth-success event listener on mount
 *   - Schedule mode (mode="schedule"): create(enabled:true) → PATCH → execute → navigate
 *   - Run mode (mode="run"): create(enabled:false) → NO PATCH → execute → navigate
 *   - Idempotency: second kh:auth-success does NOT produce a second create
 *     (guarded by sessionStorage TTL + inFlight ref + server atomic cookie clear)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_SUCCESS_EVENT } from "@/lib/auth-events";

// ---------------------------------------------------------------------------
// Mock next/navigation (real impl uses useRouter)
// ---------------------------------------------------------------------------

// vi.hoisted ensures these variables are initialized before vi.mock factories
// run (factories are hoisted to the top of the file by Vitest).
const { mockPush, mockRefresh, mockExecute, mockUseSession } = vi.hoisted(
  () => ({
    mockPush: vi.fn(),
    mockRefresh: vi.fn(),
    mockExecute: vi.fn(),
    mockUseSession: vi.fn(),
  })
);

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, refresh: mockRefresh })),
}));

// ---------------------------------------------------------------------------
// Mock @/lib/auth-client (real impl gates cookie consumption on useSession).
// Defaults to an authenticated session in beforeEach; the session-gate tests
// override it per-case.
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-client", () => ({
  useSession: mockUseSession,
}));

// ---------------------------------------------------------------------------
// Mock @/lib/api-client (real impl calls api.workflow.execute)
// ---------------------------------------------------------------------------

vi.mock("@/lib/api-client", () => ({
  api: {
    workflow: { execute: mockExecute },
  },
}));

// ---------------------------------------------------------------------------
// Capture useEffect callbacks so we can drive them manually.
// This mirrors how PendingTemplateRunner's effect is structured:
// the effect runs once on mount + adds an AUTH_SUCCESS_EVENT listener.
// ---------------------------------------------------------------------------

type EffectFn = () => unknown;
const capturedEffects: EffectFn[] = [];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (fn: EffectFn) => {
      capturedEffects.push(fn);
    },
    useRef: vi.fn(() => ({ current: false })),
  };
});

// ---------------------------------------------------------------------------
// Fake window with trackable event listeners + sessionStorage
// ---------------------------------------------------------------------------

type EventHandler = () => void;
const registeredListeners: Record<string, EventHandler[]> = {};
const sessionStorageStore: Record<string, string> = {};

const fakeSessionStorage = {
  getItem: vi.fn((key: string) => sessionStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    sessionStorageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete sessionStorageStore[key];
  }),
};

// Import AFTER mocks are hoisted.
import { PendingScanRunner } from "@/components/scan/pending-scan-runner";

// ---------------------------------------------------------------------------
// Shared intent fixtures (using descriptor.id, NOT a "suggestionSlug" field)
// ---------------------------------------------------------------------------

const SCHEDULE_INTENT = {
  id: "health-aave-v3-42161",
  address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  name: "Aave V3 Health Factor Alert",
  description: "Monitor HF on Arbitrum.",
  category: "health",
  chainId: 42_161,
  readOrWrite: "read",
  protocol: "aave-v3",
  usdValue: 5000,
  confirmInputs: { threshold: "1.5" },
  riskNote: "Read-only monitoring.",
  mode: "schedule",
};

const RUN_INTENT = {
  ...SCHEDULE_INTENT,
  id: "health-aave-v3-42161-run",
  mode: "run",
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedEffects.length = 0;
  for (const key of Object.keys(registeredListeners)) {
    registeredListeners[key] = [];
  }
  for (const key of Object.keys(sessionStorageStore)) {
    delete sessionStorageStore[key];
  }
  mockPush.mockClear();
  mockRefresh.mockClear();
  mockExecute.mockClear();
  mockUseSession.mockReset();
  mockUseSession.mockReturnValue({
    data: { user: { id: "user_test" } },
    isPending: false,
  });
  fakeSessionStorage.getItem.mockClear();
  fakeSessionStorage.setItem.mockClear();

  vi.stubGlobal("window", {
    addEventListener: (event: string, handler: EventHandler) => {
      registeredListeners[event] = [
        ...(registeredListeners[event] ?? []),
        handler,
      ];
    },
    removeEventListener: vi.fn(),
    sessionStorage: fakeSessionStorage,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper: trigger all registered AUTH_SUCCESS_EVENT handlers
// ---------------------------------------------------------------------------

function fireAuthSuccessEvent(): void {
  for (const handler of registeredListeners[AUTH_SUCCESS_EVENT] ?? []) {
    handler();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PendingScanRunner", () => {
  describe("event listener registration", () => {
    it("registers a kh:auth-success event listener on mount", () => {
      PendingScanRunner();

      // The real implementation uses useEffect to add the listener.
      // capturedEffects[0]() would trigger the effect and register the handler.
      // With the stub (no useEffect), capturedEffects is empty.
      expect(capturedEffects).toHaveLength(1); // RED: stub has no useEffect
    });
  });

  describe("schedule mode (mode='schedule')", () => {
    it("creates an enabled workflow, syncs schedule via PATCH, and executes on AUTH_SUCCESS_EVENT", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ intent: SCHEDULE_INTENT }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: "wf_abc123" }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      vi.stubGlobal("fetch", mockFetch);
      mockExecute.mockResolvedValueOnce({ id: "wf_abc123" });

      PendingScanRunner();
      // Trigger the effect (real impl: captured by useEffect mock)
      if (capturedEffects[0]) {
        await capturedEffects[0]();
      }
      fireAuthSuccessEvent();
      await new Promise((r) => setTimeout(r, 20));

      // GET /api/auth/scan-intent to clear cookie and read intent
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/auth/scan-intent",
        expect.objectContaining({ method: "GET" })
      );

      // POST /api/workflows/create with enabled:true for schedule mode
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/workflows/create",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"enabled":true'),
        })
      );

      // PATCH /api/workflows/wf_abc123 to sync schedule
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/workflows/wf_abc123",
        expect.objectContaining({ method: "PATCH" })
      );

      // Schedule mode does NOT auto-run: the enabled schedule fires it.
      expect(mockExecute).not.toHaveBeenCalled();

      // Navigate to workflow canvas
      expect(mockPush).toHaveBeenCalledWith("/workflows/wf_abc123");
    });
  });

  describe("run mode (mode='run')", () => {
    it("creates a disabled workflow, skips PATCH, and executes on AUTH_SUCCESS_EVENT", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ intent: RUN_INTENT }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: "wf_run456" }),
        });

      vi.stubGlobal("fetch", mockFetch);
      mockExecute.mockResolvedValueOnce({ id: "wf_run456" });

      PendingScanRunner();
      if (capturedEffects[0]) {
        await capturedEffects[0]();
      }
      fireAuthSuccessEvent();
      await new Promise((r) => setTimeout(r, 20));

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/workflows/create",
        expect.objectContaining({
          method: "POST",
          body: expect.not.stringContaining('"enabled":true'),
        })
      );

      // PATCH must NOT be called for run mode (no schedule sync needed)
      const patchCalls = mockFetch.mock.calls.filter(
        ([, opts]) =>
          (opts as { method?: string })?.method?.toUpperCase() === "PATCH"
      );
      expect(patchCalls).toHaveLength(0);

      expect(mockExecute).toHaveBeenCalledWith("wf_run456", {});
      expect(mockPush).toHaveBeenCalledWith("/workflows/wf_run456");
    });
  });

  describe("idempotency", () => {
    it("second AUTH_SUCCESS_EVENT does not produce a second workflow create", async () => {
      // First call: intent present in cookie → create workflow
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ intent: SCHEDULE_INTENT }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: "wf_idem789" }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        // Second call: server cleared the cookie → intent is null
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ intent: null }),
        });

      vi.stubGlobal("fetch", mockFetch);
      mockExecute.mockResolvedValue({ id: "wf_idem789" });

      PendingScanRunner();
      if (capturedEffects[0]) {
        await capturedEffects[0]();
      }

      // First event: workflow created
      fireAuthSuccessEvent();
      await new Promise((r) => setTimeout(r, 20));

      // Second event: cookie is gone (server cleared it); sessionStorage TTL
      // also blocks re-entry within 30s
      fireAuthSuccessEvent();
      await new Promise((r) => setTimeout(r, 20));

      // Only one workflow create call (idempotency)
      const createCalls = mockFetch.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/workflows/create")
      );
      expect(createCalls).toHaveLength(1);
    });
  });

  describe("session gate (guard d)", () => {
    it("does not consume the intent cookie while anonymous", async () => {
      mockUseSession.mockReturnValue({ data: null, isPending: false });
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      PendingScanRunner();
      for (const effect of capturedEffects) {
        await effect();
      }

      // The effect must bail before touching GET /api/auth/scan-intent (which
      // atomically clears the cookie) and before wiring the auth listener.
      expect(mockFetch).not.toHaveBeenCalled();
      expect(registeredListeners[AUTH_SUCCESS_EVENT] ?? []).toHaveLength(0);
    });

    it("does not consume the intent cookie while the session is still loading", async () => {
      mockUseSession.mockReturnValue({ data: null, isPending: true });
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      PendingScanRunner();
      for (const effect of capturedEffects) {
        await effect();
      }

      expect(mockFetch).not.toHaveBeenCalled();
      expect(registeredListeners[AUTH_SUCCESS_EVENT] ?? []).toHaveLength(0);
    });

    it("does not consume the intent cookie for a Better Auth anonymous session", async () => {
      // The funnel mints anonymous sessions on many surfaces; they carry a
      // user object (id + org) but name "Anonymous". Consuming the cookie under
      // one would persist the workflow to the throwaway account and 401/403 at
      // execute — the gate must treat anonymous sessions as unauthenticated.
      mockUseSession.mockReturnValue({
        data: { user: { id: "anon_1", name: "Anonymous" } },
        isPending: false,
      });
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      PendingScanRunner();
      for (const effect of capturedEffects) {
        await effect();
      }

      expect(mockFetch).not.toHaveBeenCalled();
      expect(registeredListeners[AUTH_SUCCESS_EVENT] ?? []).toHaveLength(0);
    });
  });
});
