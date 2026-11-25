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
import { unsupportedSendMode } from "@/lib/web3/send-mode";

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
const CASES: [Record<string, unknown>, Outcome, Outcome][] = [
  [{ usePrivateMempool: true }, "relay", "refused"],
  [{ sendMode: "private-relay" }, "relay", "refused"],
  [{ sendMode: "private-relay", usePrivateMempool: true }, "relay", "refused"],
  // Old non-boolean values send as before: relay where there is one.
  [{ usePrivateMempool: "false" }, "relay", "public"],
  [{ usePrivateMempool: 1 }, "relay", "public"],
  [{ usePrivateMempool: "yes" }, "relay", "public"],
  [{ usePrivateMempool: "true" }, "relay", "public"],
  [{ usePrivateMempool: 0 }, "public", "public"],
  [{ usePrivateMempool: "" }, "public", "public"],
  [{ usePrivateMempool: null }, "public", "public"],
  [{ usePrivateMempool: false }, "public", "public"],
  [{}, "public", "public"],
  [{ sendMode: "transaction" }, "public", "public"],
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
  it.each(CASES)("%j: Ethereum %s, Base %s", async (input, onEth, onBase) => {
    const eth = await outcome(ETHEREUM, input);
    expect(eth.outcome).toBe(onEth);
    expect(eth.relayRequested).toBe(onEth === "relay");

    const base = await outcome(BASE, input);
    expect(base.outcome).toBe(onBase);
    if (onBase === "refused") {
      expect(base.error).toBeInstanceOf(PrivateRelayUnavailableError);
      expect(rpcRelayErrorClass(base.error)).toBe("user");
    } else {
      // Public on Base, so sponsorship stays possible.
      expect(base.relayRequested).toBe(false);
    }
  });

  it("sends a strict: false relay request publicly where there is none, never sponsored", async () => {
    const base = await outcome(BASE, {
      usePrivateMempool: true,
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

  it("refuses any relay use a step cannot make (Batch), strict: false included", async () => {
    const reason =
      "Batch Write Contract can't send through the private relay yet";
    for (const input of [
      { usePrivateMempool: true },
      { usePrivateMempool: true, strict: false },
      { sendMode: "private-relay" },
    ]) {
      for (const chain of [ETHEREUM, BASE]) {
        const result = await outcome(chain, input, reason);
        expect(result.outcome).toBe("refused");
        expect((result.error as Error).message).toBe(reason);
      }
    }
    // A required relay is refused before any RPC is resolved.
    expect(state.calls).toBe(0);
    // An old non-boolean flag uses the relay only on Ethereum.
    expect(
      (await outcome(ETHEREUM, { usePrivateMempool: "false" }, reason)).outcome
    ).toBe("refused");
    expect(
      (await outcome(BASE, { usePrivateMempool: "false" }, reason)).outcome
    ).toBe("public");
    // Refused before the relay is asked which chain it serves.
    expect(state.chainChecks).toBe(0);
  });

  it("checks the relay's chain once it is the route", async () => {
    await outcome(ETHEREUM, { sendMode: "private-relay" });
    expect(state.chainChecks).toBe(1);
    await outcome(ETHEREUM, { sendMode: "transaction" });
    expect(state.chainChecks).toBe(1);
  });

  it("names the editor label and the API value in every refusal", async () => {
    const noRelay = await outcome(BASE, { sendMode: "private-relay" });
    expect((noRelay.error as Error).message).toContain(
      'Set Send as to Normal transaction (sendMode: "transaction").'
    );
    const unknown = await outcome(ETHEREUM, { sendMode: "bundle" });
    expect((unknown.error as Error).message).toBe(
      'sendMode must be "transaction" (Normal transaction) or "private-relay" (Private relay), not "bundle".'
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
