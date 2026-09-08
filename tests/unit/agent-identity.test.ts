import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("agent identity", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadWith(
    overrides: Record<string, string | undefined>
  ): Promise<typeof import("@/lib/agent-identity")> {
    const {
      AGENT_NAME: _n,
      AGENT_DESCRIPTION: _d,
      AGENT_ID: _i,
      AGENT_REGISTRY_ADDRESS: _r,
      AGENT_REGISTRY_CHAIN: _c,
      AGENT_REGISTRY_CHAIN_ID: _ci,
      ...rest
    } = originalEnv;
    const next: Record<string, string> = {
      ...(rest as Record<string, string>),
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        next[key] = value;
      }
    }
    process.env = next as NodeJS.ProcessEnv;
    return await import("@/lib/agent-identity");
  }

  // Production configures none of these, so the defaults are what it serves.
  describe("unconfigured", () => {
    it("keeps the KeeperHub name and registration", async () => {
      const { agentName, onChainIdentity } = await loadWith({});
      expect(agentName()).toBe("KeeperHub");
      expect(onChainIdentity()).toEqual({
        agentId: 31_875,
        chain: "ethereum",
        chainId: 1,
        registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      });
    });

    it("falls back to the caller's description", async () => {
      const { agentDescription } = await loadWith({});
      expect(agentDescription("original text")).toBe("original text");
    });
  });

  // The coherence guard. A renamed deployment publishing our agent id would be
  // believed by a reputation reader, which is worse than publishing nothing.
  describe("renamed without its own registration", () => {
    it("withholds the on-chain identity", async () => {
      const { agentName, onChainIdentity } = await loadWith({
        AGENT_NAME: "Acme Automations",
      });
      expect(agentName()).toBe("Acme Automations");
      expect(onChainIdentity()).toBeNull();
    });

    it("withholds it for a non-numeric or zero agent id too", async () => {
      for (const bad of ["not-a-number", "0", "-1", "  "]) {
        vi.resetModules();
        const { onChainIdentity } = await loadWith({
          AGENT_NAME: "Acme Automations",
          AGENT_ID: bad,
        });
        expect(onChainIdentity()).toBeNull();
      }
    });
  });

  describe("renamed with its own registration", () => {
    it("publishes the operator's identity, never ours", async () => {
      const { onChainIdentity } = await loadWith({
        AGENT_NAME: "Acme Automations",
        AGENT_ID: "42",
        AGENT_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000000ff",
        AGENT_REGISTRY_CHAIN: "base",
        AGENT_REGISTRY_CHAIN_ID: "8453",
      });
      expect(onChainIdentity()).toEqual({
        agentId: 42,
        chain: "base",
        chainId: 8453,
        registry: "0x00000000000000000000000000000000000000ff",
      });
    });
  });

  describe("deriveBaseUrl", () => {
    it("prefers the configured app URL and strips a trailing slash", async () => {
      const { deriveBaseUrl } = await loadWith({
        NEXT_PUBLIC_APP_URL: "https://kh.acme.example/",
      });
      expect(deriveBaseUrl(new Request("https://ignored.example/x"))).toBe(
        "https://kh.acme.example"
      );
    });

    it("falls back to the request host rather than a KeeperHub URL", async () => {
      const { deriveBaseUrl } = await loadWith({
        NEXT_PUBLIC_APP_URL: undefined,
        BETTER_AUTH_URL: undefined,
      });
      expect(deriveBaseUrl(new Request("https://kh.acme.example/a/b"))).toBe(
        "https://kh.acme.example"
      );
    });
  });
});
