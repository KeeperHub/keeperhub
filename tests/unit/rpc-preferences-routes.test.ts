/**
 * Unit tests for RPC Preferences API routes
 *
 * Tests the API route handlers with mocked auth and services
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/safe-fetch` is now a transitive import via the route handler's
// SSRF guard. It declares `import "server-only"`, which throws under
// vitest unless stubbed.
vi.mock("server-only", () => ({}));

// Mock auth before imports
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock services before imports
vi.mock("@/lib/rpc/chain-service", () => ({
  getChainByChainId: vi.fn(),
}));

vi.mock("@/lib/rpc/config-service", () => ({
  deleteUserRpcPreference: vi.fn(),
  getUserRpcPreferences: vi.fn(),
  resolveAllRpcConfigs: vi.fn(),
  resolveRpcConfig: vi.fn(),
  setUserRpcPreference: vi.fn(),
}));

// Mock DNS so the SSRF guard in the PUT handler doesn't hit the real
// network. Default behaviour returns a public IP; individual tests override
// via mockPromisesLookup.mockResolvedValue / mockRejectedValue.
const { mockPromisesLookup } = vi.hoisted(() => ({
  mockPromisesLookup: vi.fn(),
}));
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: mockPromisesLookup,
    },
  };
});

// Sentry is pulled in transitively via lib/safe-fetch; stub it out so the
// test runner doesn't try to initialise the SDK.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

import {
  DELETE,
  GET as getSingleConfig,
  PUT,
} from "@/app/api/user/rpc-preferences/[chainId]/route";
import { GET as getAllPreferences } from "@/app/api/user/rpc-preferences/route";
import { auth } from "@/lib/auth";
import { getChainByChainId } from "@/lib/rpc/chain-service";
import {
  deleteUserRpcPreference,
  getUserRpcPreferences,
  resolveAllRpcConfigs,
  resolveRpcConfig,
  setUserRpcPreference,
} from "@/lib/rpc/config-service";

describe("RPC Preferences API Routes", () => {
  const mockUser = {
    id: "user_123",
    email: "test@example.com",
    name: "Test User",
    emailVerified: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    displayNameConfirmed: false,
    onboardingCompleted: false,
  };
  const mockSessionData = {
    id: "session_123",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    userId: "user_123",
    expiresAt: new Date("2026-12-31"),
    token: "mock_token",
    ipAddress: null,
    userAgent: null,
    requiresMfa: false,
  };
  const mockSession = { session: mockSessionData, user: mockUser };

  const mockChain = {
    id: "chain_1",
    chainId: 1,
    name: "Ethereum Mainnet",
    symbol: "ETH",
    aliases: ["ethereum", "eth"],
    isPaymentRail: false,
    chainType: "evm",
    defaultPrimaryRpc: "https://eth.example.com",
    defaultFallbackRpc: "https://eth-backup.example.com",
    defaultPrimaryWss: null,
    defaultFallbackWss: null,
    usePrivateMempoolRpc: false,
    defaultPrivateRpcUrl: null,
    isEnabled: true,
    status: "stable",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    isTestnet: false,
    gasConfig: {},
  };

  const mockPreference = {
    id: "pref_1",
    userId: "user_123",
    chainId: 1,
    primaryRpcUrl: "https://custom-eth.example.com",
    fallbackRpcUrl: "https://custom-eth-backup.example.com",
    primaryWssUrl: null,
    fallbackWssUrl: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockResolvedConfig = {
    chainId: 1,
    chainName: "Ethereum Mainnet",
    primaryRpcUrl: "https://custom-eth.example.com",
    fallbackRpcUrl: "https://custom-eth-backup.example.com",
    source: "user" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: any hostname resolves to a public address. Override per-test
    // for SSRF-block scenarios.
    mockPromisesLookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  });

  // Helper to create mock request
  const createRequest = (options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) => {
    const { method = "GET", headers = {}, body } = options;
    return new Request("http://localhost:3000/api/test", {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  // Helper to create params promise (Next.js 15 style)
  const createParams = (chainId: string) => Promise.resolve({ chainId });

  describe("GET /api/user/rpc-preferences", () => {
    it("should return 401 when not authenticated", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const request = createRequest({});
      const response = await getAllPreferences(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return preferences and resolved configs for authenticated user", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(getUserRpcPreferences).mockResolvedValue([mockPreference]);
      vi.mocked(resolveAllRpcConfigs).mockResolvedValue([mockResolvedConfig]);

      const request = createRequest({});
      const response = await getAllPreferences(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.preferences).toHaveLength(1);
      expect(data.preferences[0].chainId).toBe(1);
      expect(data.resolved).toHaveLength(1);
      expect(data.resolved[0].source).toBe("user");
    });

    it("should return empty arrays when user has no preferences", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(getUserRpcPreferences).mockResolvedValue([]);
      vi.mocked(resolveAllRpcConfigs).mockResolvedValue([
        { ...mockResolvedConfig, source: "default" as const },
      ]);

      const request = createRequest({});
      const response = await getAllPreferences(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.preferences).toHaveLength(0);
      expect(data.resolved[0].source).toBe("default");
    });
  });

  describe("GET /api/user/rpc-preferences/:chainId", () => {
    it("should return 401 when not authenticated", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const request = createRequest({});
      const response = await getSingleConfig(request, {
        params: createParams("1"),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return 400 for invalid chain ID", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      const request = createRequest({});
      const response = await getSingleConfig(request, {
        params: createParams("invalid"),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid chain ID");
    });

    it("should return 404 when chain not found", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(resolveRpcConfig).mockResolvedValue(null);

      const request = createRequest({});
      const response = await getSingleConfig(request, {
        params: createParams("999"),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toContain("not found or disabled");
    });

    it("should return resolved config with source field", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(resolveRpcConfig).mockResolvedValue(mockResolvedConfig);

      const request = createRequest({});
      const response = await getSingleConfig(request, {
        params: createParams("1"),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.chainId).toBe(1);
      expect(data.chainName).toBe("Ethereum Mainnet");
      expect(data.source).toBe("user");
      expect(resolveRpcConfig).toHaveBeenCalledWith(1, "user_123");
    });

    it("should return default source when no user preference", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(resolveRpcConfig).mockResolvedValue({
        ...mockResolvedConfig,
        primaryRpcUrl: "https://eth.example.com",
        source: "default",
      });

      const request = createRequest({});
      const response = await getSingleConfig(request, {
        params: createParams("1"),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.source).toBe("default");
    });
  });

  describe("PUT /api/user/rpc-preferences/:chainId", () => {
    it("should return 401 when not authenticated", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const request = createRequest({
        method: "PUT",
        body: { primaryRpcUrl: "https://new-rpc.example.com" },
      });
      const response = await PUT(request, { params: createParams("1") });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return 400 for invalid chain ID", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      const request = createRequest({
        method: "PUT",
        body: { primaryRpcUrl: "https://new-rpc.example.com" },
      });
      const response = await PUT(request, { params: createParams("invalid") });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid chain ID");
    });

    it("should return 404 when chain not found", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(getChainByChainId).mockResolvedValue(null);

      const request = createRequest({
        method: "PUT",
        body: { primaryRpcUrl: "https://new-rpc.example.com" },
      });
      const response = await PUT(request, { params: createParams("999") });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toContain("not found");
    });

    it("should return 400 when primaryRpcUrl is missing", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(getChainByChainId).mockResolvedValue(mockChain);

      const request = createRequest({
        method: "PUT",
        body: {},
      });
      const response = await PUT(request, { params: createParams("1") });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("primaryRpcUrl is required");
    });

    it("should return 400 for invalid URL format", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(getChainByChainId).mockResolvedValue(mockChain);

      const request = createRequest({
        method: "PUT",
        body: { primaryRpcUrl: "not-a-valid-url" },
      });
      const response = await PUT(request, { params: createParams("1") });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid RPC URL format");
    });

    it("should create preference successfully", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(getChainByChainId).mockResolvedValue(mockChain);
      vi.mocked(setUserRpcPreference).mockResolvedValue(mockPreference);

      const request = createRequest({
        method: "PUT",
        body: {
          primaryRpcUrl: "https://custom-eth.example.com",
          fallbackRpcUrl: "https://custom-eth-backup.example.com",
        },
      });
      const response = await PUT(request, { params: createParams("1") });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.chainId).toBe(1);
      expect(data.primaryRpcUrl).toBe("https://custom-eth.example.com");
      expect(setUserRpcPreference).toHaveBeenCalledWith(
        "user_123",
        1,
        "https://custom-eth.example.com",
        "https://custom-eth-backup.example.com"
      );
    });

    it("should create preference without fallback URL", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(getChainByChainId).mockResolvedValue(mockChain);
      vi.mocked(setUserRpcPreference).mockResolvedValue({
        ...mockPreference,
        fallbackRpcUrl: null,
      });

      const request = createRequest({
        method: "PUT",
        body: { primaryRpcUrl: "https://custom-eth.example.com" },
      });
      const response = await PUT(request, { params: createParams("1") });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.fallbackRpcUrl).toBeNull();
    });

    describe("SSRF guard", () => {
      const ssrfBlockedLiterals: [string, string][] = [
        ["loopback IPv4", "http://127.0.0.1:8545/"],
        ["link-local IMDS", "http://169.254.169.254/latest/meta-data/"],
        ["RFC1918", "http://10.0.0.1:8545/"],
        ["RFC1918 192.168", "http://192.168.1.1:8545/"],
        ["loopback IPv6", "https://[::1]:8545/"],
        ["link-local IPv6", "https://[fe80::1]:8545/"],
        [
          "IPv4-mapped IPv6 IMDS",
          "http://[::ffff:169.254.169.254]/latest/meta-data/",
        ],
      ];

      for (const [label, url] of ssrfBlockedLiterals) {
        it(`should return 400 for ${label} primaryRpcUrl (${url})`, async () => {
          vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
          vi.mocked(getChainByChainId).mockResolvedValue(mockChain);

          const request = createRequest({
            method: "PUT",
            body: { primaryRpcUrl: url },
          });
          const response = await PUT(request, { params: createParams("1") });
          const data = await response.json();

          expect(response.status).toBe(400);
          expect(data.error).toBe("RPC URL points to a non-public address");
          expect(setUserRpcPreference).not.toHaveBeenCalled();
        });
      }

      it("should return 400 when fallbackRpcUrl resolves to a private IP", async () => {
        vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
        vi.mocked(getChainByChainId).mockResolvedValue(mockChain);
        // Primary resolves public, fallback resolves private. The handler
        // must validate both — leaving the fallback unchecked would let an
        // attacker stash an internal URL behind a "valid" primary.
        mockPromisesLookup
          .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
          .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);

        const request = createRequest({
          method: "PUT",
          body: {
            primaryRpcUrl: "https://public.example.com",
            fallbackRpcUrl: "https://internal.example.com",
          },
        });
        const response = await PUT(request, { params: createParams("1") });
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toBe("RPC URL points to a non-public address");
        expect(setUserRpcPreference).not.toHaveBeenCalled();
      });

      it("should return 400 when DNS resolution fails", async () => {
        vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
        vi.mocked(getChainByChainId).mockResolvedValue(mockChain);
        mockPromisesLookup.mockRejectedValue(
          Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })
        );

        const request = createRequest({
          method: "PUT",
          body: { primaryRpcUrl: "https://nonexistent.example.com" },
        });
        const response = await PUT(request, { params: createParams("1") });
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toBe("Could not resolve RPC URL host");
        expect(setUserRpcPreference).not.toHaveBeenCalled();
      });

      it("should return 400 for non-http(s) scheme", async () => {
        vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
        vi.mocked(getChainByChainId).mockResolvedValue(mockChain);

        const request = createRequest({
          method: "PUT",
          body: { primaryRpcUrl: "file:///etc/passwd" },
        });
        const response = await PUT(request, { params: createParams("1") });
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toBe("RPC URL points to a non-public address");
        expect(setUserRpcPreference).not.toHaveBeenCalled();
      });

      it("should accept domain that resolves to a public address", async () => {
        vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
        vi.mocked(getChainByChainId).mockResolvedValue(mockChain);
        vi.mocked(setUserRpcPreference).mockResolvedValue(mockPreference);
        mockPromisesLookup.mockResolvedValue([
          { address: "8.8.8.8", family: 4 },
        ]);

        const request = createRequest({
          method: "PUT",
          body: { primaryRpcUrl: "https://rpc.publicnode.com" },
        });
        const response = await PUT(request, { params: createParams("1") });

        expect(response.status).toBe(200);
        expect(setUserRpcPreference).toHaveBeenCalled();
      });
    });
  });

  describe("DELETE /api/user/rpc-preferences/:chainId", () => {
    it("should return 401 when not authenticated", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const request = createRequest({ method: "DELETE" });
      const response = await DELETE(request, { params: createParams("1") });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return 400 for invalid chain ID", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      const request = createRequest({ method: "DELETE" });
      const response = await DELETE(request, {
        params: createParams("invalid"),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid chain ID");
    });

    it("should return 404 when preference not found", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(deleteUserRpcPreference).mockResolvedValue(false);

      const request = createRequest({ method: "DELETE" });
      const response = await DELETE(request, { params: createParams("999") });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe("RPC preference not found");
    });

    it("should delete preference successfully", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
      vi.mocked(deleteUserRpcPreference).mockResolvedValue(true);

      const request = createRequest({ method: "DELETE" });
      const response = await DELETE(request, { params: createParams("1") });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(deleteUserRpcPreference).toHaveBeenCalledWith("user_123", 1);
    });
  });
});
