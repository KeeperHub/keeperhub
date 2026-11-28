import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  chain: undefined as Record<string, unknown> | undefined,
  calls: 0,
  chainChecks: 0,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.chain ? [state.chain] : []),
        }),
      }),
    }),
  },
}));

// The real config resolution decides the route; only the manager is a stub.
vi.mock("@/lib/rpc/provider-factory", async () => {
  const { resolveRpcConfig } = await import("@/lib/rpc/config-service");
  return {
    getRpcProvider: async (options: {
      chainId: number;
      usePrivateMempool?: boolean;
      strict?: boolean;
      relayOptional?: boolean;
    }) => {
      state.calls += 1;
      const config = await resolveRpcConfig(options.chainId, undefined, {
        usePrivateMempool: options.usePrivateMempool,
        strict: options.strict,
        relayOptional: options.relayOptional,
      });
      return {
        primaryRpcUrl: config?.primaryRpcUrl,
        fallbackRpcUrl: config?.fallbackRpcUrl,
        hasPrivateRelayPrimary: () => config?.primaryIsPrivateRelay === true,
        assertPrivateRelayChain: () => {
          state.chainChecks += 1;
          return Promise.resolve();
        },
      };
    },
  };
});

import {
  InvalidSendModeError,
  PrivateRelayUnavailableError,
  rpcRelayErrorClass,
} from "@/lib/rpc/providers";
import { getSendRpcProvider } from "@/lib/rpc/send-provider";
import {
  BUNDLE_SEND_MODES,
  SEND_MODE,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";

const ETHEREUM = {
  chainId: 1,
  name: "Ethereum",
  isEnabled: true,
  defaultPrimaryRpc: "https://public.example/eth",
  usePrivateMempoolRpc: true,
  defaultPrivateRpcUrl: "https://relay.example",
};
const BASE = {
  chainId: 8453,
  name: "Base",
  isEnabled: true,
  defaultPrimaryRpc: "https://public.example/base",
  usePrivateMempoolRpc: false,
};

type Outcome = "relay" | "public" | "refused";
// [keys, Ethereum, Base, never sponsored on Base]
const CASES: [Record<string, unknown>, Outcome, Outcome, boolean][] = [
  // The old flag alone: the relay where there is one, else public and unsponsored, as before.
  [{ usePrivateMempool: true }, "relay", "public", true],
  [{ sendMode: "private-relay" }, "relay", "refused", true],
  [
    { sendMode: "private-relay", usePrivateMempool: true },
    "relay",
    "refused",
    true,
  ],
  [{ usePrivateMempool: "false" }, "relay", "public", true],
  [{ usePrivateMempool: 1 }, "relay", "public", true],
  [{ usePrivateMempool: "yes" }, "relay", "public", true],
  [{ usePrivateMempool: "true" }, "relay", "public", true],
  [{ usePrivateMempool: 0 }, "public", "public", false],
  [{ usePrivateMempool: "" }, "public", "public", false],
  [{ usePrivateMempool: null }, "public", "public", false],
  [{ usePrivateMempool: false }, "public", "public", false],
  [{}, "public", "public", false],
  [{ sendMode: "transaction" }, "public", "public", false],
];

async function outcome(
  chain: Record<string, unknown>,
  input: Record<string, unknown>,
  relayRefusal?: string
): Promise<{ outcome: Outcome; relayRequested?: boolean; error?: unknown }> {
  state.chain = chain;
  try {
    const send = await getSendRpcProvider(input, {
      chainId: Number(chain.chainId),
      relayRefusal,
    });
    return {
      outcome: send.rpcManager.hasPrivateRelayPrimary() ? "relay" : "public",
      relayRequested: send.relayRequested,
    };
  } catch (error) {
    return { outcome: "refused", error };
  }
}

beforeEach(() => {
  state.calls = 0;
  state.chainChecks = 0;
});

describe("getSendRpcProvider: every step's route", () => {
  it.each(CASES)(
    "%j: Ethereum %s, Base %s",
    async (input, onEth, onBase, unsponsored) => {
      const eth = await outcome(ETHEREUM, input);
      expect(eth.outcome).toBe(onEth);
      expect(eth.relayRequested).toBe(onEth === "relay");

      const base = await outcome(BASE, input);
      expect(base.outcome).toBe(onBase);
      if (onBase === "refused") {
        expect(base.error).toBeInstanceOf(PrivateRelayUnavailableError);
        expect(rpcRelayErrorClass(base.error)).toBe("user");
      } else {
        // A step that asked for the relay was never sponsored, and still is not.
        expect(base.relayRequested).toBe(unsponsored);
      }
    }
  );

  it("sends a strict: false relay request publicly where there is none, never sponsored", async () => {
    const base = await outcome(BASE, {
      sendMode: "private-relay",
      strict: false,
    });
    expect(base).toMatchObject({ outcome: "public", relayRequested: true });
  });

  it.each([
    "Private-Relay",
    "private_relay",
    " private-relay",
    true,
    "{{@x:X.mode}}",
  ])("refuses sendMode %j as a user error before any RPC", async (sendMode) => {
    for (const chain of [ETHEREUM, BASE]) {
      const result = await outcome(chain, { sendMode });
      expect(result.error).toBeInstanceOf(InvalidSendModeError);
      expect(rpcRelayErrorClass(result.error)).toBe("user");
    }
    expect(state.calls).toBe(0);
  });

  it("refuses sendMode private-relay on a step that cannot use it (Batch), strict: false included", async () => {
    const reason =
      "Batch Write Contract can't send through the private relay yet";
    for (const input of [
      { sendMode: "private-relay" },
      { sendMode: "private-relay", strict: false },
    ]) {
      for (const chain of [ETHEREUM, BASE]) {
        const result = await outcome(chain, input, reason);
        expect(result.outcome).toBe("refused");
        expect((result.error as Error).message).toBe(reason);
      }
    }
    // A required relay is refused before any RPC is resolved.
    expect(state.calls).toBe(0);
    expect(state.chainChecks).toBe(0);
  });

  // The old flag alone on such a step runs as before Send as, on every kind of chain.
  const RELAY_FLAG_NO_URL = {
    ...ETHEREUM,
    chainId: 11_155_111,
    name: "Sepolia",
    defaultPrivateRpcUrl: null,
  };
  it.each([
    ["a chain with a relay", ETHEREUM, "relay"],
    ["a chain without one", BASE, "public"],
    ["a chain with the flag on but no relay URL", RELAY_FLAG_NO_URL, "public"],
  ] as const)(
    "keeps an old Batch flag's route on %s",
    async (_label, chain, route) => {
      const reason =
        "Batch Write Contract can't send through the private relay yet";
      for (const input of [
        { usePrivateMempool: true },
        { usePrivateMempool: true, strict: false },
        { usePrivateMempool: "false" },
      ]) {
        const result = await outcome(chain, input, reason);
        expect(result).toMatchObject({ outcome: route, relayRequested: true });
      }
    }
  );

  it("builds an old Batch flag's relay manager as before: strict unless strict: false", async () => {
    const reason =
      "Batch Write Contract can't send through the private relay yet";
    state.chain = ETHEREUM;
    const strict = await getSendRpcProvider(
      { usePrivateMempool: true },
      { chainId: 1, relayRefusal: reason }
    );
    const loose = await getSendRpcProvider(
      { usePrivateMempool: true, strict: false },
      { chainId: 1, relayRefusal: reason }
    );
    expect(strict.rpcManager).toMatchObject({
      primaryRpcUrl: "https://relay.example",
      fallbackRpcUrl: undefined,
    });
    expect(loose.rpcManager).toMatchObject({
      primaryRpcUrl: "https://relay.example",
      fallbackRpcUrl: "https://public.example/eth",
    });
    // The relay is asked which chain it serves, as for every relay send.
    expect(state.chainChecks).toBe(2);
  });

  it("checks the relay's chain once it is the route", async () => {
    await outcome(ETHEREUM, { sendMode: "private-relay" });
    expect(state.chainChecks).toBe(1);
    await outcome(ETHEREUM, { sendMode: "transaction" });
    expect(state.chainChecks).toBe(1);
  });

  it("refuses a bundle on any step that does not allow one, before any RPC", async () => {
    const refused = await outcome(ETHEREUM, { sendMode: "bundle" });
    expect(refused.outcome).toBe("refused");
    expect(refused.error).toBeInstanceOf(InvalidSendModeError);
    expect((refused.error as Error).message).toBe(
      'This step is set to Send as: Bundle (sendMode: "bundle"), but bundles are only available on Write Contract steps. Set Send as to Normal transaction (sendMode: "transaction").'
    );
    expect(state.calls).toBe(0);
  });

  it("reads through the public RPC for a bundle where one is allowed", async () => {
    state.chain = ETHEREUM;
    const send = await getSendRpcProvider(
      { sendMode: "bundle", usePrivateMempool: false },
      { chainId: 1, allowBundle: true }
    );
    expect(send.rpcManager.hasPrivateRelayPrimary()).toBe(false);
    expect(send.relayRequested).toBe(false);
    expect(send.bundleRequested).toBe(true);
  });

  it.each(BUNDLE_SEND_MODES)(
    "treats every bundle mode as a bundle: %s",
    async (sendMode) => {
      const refused = await outcome(ETHEREUM, { sendMode });
      expect(refused.error).toBeInstanceOf(InvalidSendModeError);
      expect(state.calls).toBe(0);
      state.chain = ETHEREUM;
      const send = await getSendRpcProvider(
        { sendMode },
        { chainId: 1, allowBundle: true }
      );
      expect(send.bundleRequested).toBe(true);
      expect(send.rpcManager.hasPrivateRelayPrimary()).toBe(false);
    }
  );

  it.each([SEND_MODE.TRANSACTION, SEND_MODE.PRIVATE_RELAY])(
    "does not treat %s as a bundle",
    async (sendMode) => {
      state.chain = ETHEREUM;
      const send = await getSendRpcProvider(
        { sendMode },
        { chainId: 1, allowBundle: true }
      );
      expect(send.bundleRequested).toBe(false);
    }
  );

  it("names the editor label and the API value in every refusal", async () => {
    const noRelay = await outcome(BASE, { sendMode: "private-relay" });
    expect((noRelay.error as Error).message).toContain(
      'Set Send as to Normal transaction (sendMode: "transaction").'
    );
    const unknown = await outcome(ETHEREUM, { sendMode: "Bundle" });
    expect((unknown.error as Error).message).toBe(
      'sendMode must be "transaction" (Normal transaction), "private-relay" (Private relay) or "bundle" (Bundle), not "Bundle".'
    );
    const batch = await outcome(
      ETHEREUM,
      { sendMode: "private-relay" },
      unsupportedSendMode("web3/batch-write-contract", "private-relay")
    );
    expect((batch.error as Error).message).toContain(
      'Set Send as to Normal transaction (sendMode: "transaction")'
    );
  });
});
