import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const guard = vi.hoisted(() => ({ assert: vi.fn() }));

vi.mock("@/lib/policy/guard", () => ({
  enforcePolicy: guard.assert,
}));

import { guardSigner } from "@/lib/policy/signing-guard";

/**
 * Both ways a transaction leaves this process have to be judged.
 *
 * The broadcast path that uses our own RPC failover never calls
 * sendTransaction: it populates, signs, and puts the raw hex on the wire. A
 * guard that watched only sendTransaction therefore stood behind the fallback
 * and not the path nearly every write takes.
 */
const CONTEXT = {
  organizationId: "org_1",
  chainId: 8453,
} as unknown as Parameters<typeof guardSigner>[1];

const TX = { to: "0xabc", data: "0x", value: BigInt(1) };

function signerDouble() {
  return {
    sendTransaction: vi.fn(() => Promise.resolve("sent")),
    signTransaction: vi.fn(() => Promise.resolve("0xsigned")),
    populateTransaction: vi.fn((t: unknown) => Promise.resolve(t)),
    getAddress: vi.fn(() => Promise.resolve("0xme")),
  };
}

describe("what the signer guard stands behind", () => {
  beforeEach(() => {
    guard.assert.mockReset();
    // Allowed, so the call proceeds and the test is about reach, not refusal.
    guard.assert.mockResolvedValue({ blocked: false, decision: {} });
  });

  it("checks a sendTransaction", async () => {
    const signer = signerDouble();
    const guarded = guardSigner(
      signer as unknown as Parameters<typeof guardSigner>[0],
      CONTEXT
    );

    await (
      guarded as unknown as {
        sendTransaction: (t: unknown) => Promise<unknown>;
      }
    ).sendTransaction(TX);

    expect(guard.assert).toHaveBeenCalledTimes(1);
    expect(signer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("checks a signTransaction, which is how a write is actually broadcast", async () => {
    const signer = signerDouble();
    const guarded = guardSigner(
      signer as unknown as Parameters<typeof guardSigner>[0],
      CONTEXT
    );

    await (
      guarded as unknown as {
        signTransaction: (t: unknown) => Promise<unknown>;
      }
    ).signTransaction(TX);

    expect(guard.assert).toHaveBeenCalledTimes(1);
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("leaves everything else on the signer alone", async () => {
    const signer = signerDouble();
    const guarded = guardSigner(
      signer as unknown as Parameters<typeof guardSigner>[0],
      CONTEXT
    );

    await (
      guarded as unknown as { getAddress: () => Promise<string> }
    ).getAddress();
    await (
      guarded as unknown as {
        populateTransaction: (t: unknown) => Promise<unknown>;
      }
    ).populateTransaction(TX);

    // Populating does not commit to anything; the signature does.
    expect(guard.assert).not.toHaveBeenCalled();
  });
});
