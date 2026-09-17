/**
 * The pre-broadcast hook on the Solana adapter. The signature is fixed by the
 * signed bytes, so the hook can record it before submission; a caller that
 * holds it can look the transaction up whatever the submit call reports.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "VALIDATION" },
  logDebug: vi.fn(),
  logUserError: vi.fn(),
  logWarn: vi.fn(),
}));

import { Keypair } from "@solana/web3.js";
import type { ethers } from "ethers";
import {
  type BroadcastEvent,
  BroadcastHookError,
} from "@/lib/web3/broadcast-hook";
import { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import type { TransactionOptions } from "@/lib/web3/chain-adapter/types";
import type { NonceSession } from "@/lib/web3/nonce-manager";
import { SolanaKeypairSigner } from "@/lib/web3/solana-signer";
import { deriveSolanaSignature } from "@/lib/web3/submit-signed-solana";

const DEVNET_CHAIN_ID = 103;

function harness(order: string[]) {
  const connection = {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      lastValidBlockHeight: 123_456,
    }),
    simulateTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: null, logs: [] } }),
    sendRawTransaction: vi.fn((bytes: Uint8Array) => {
      order.push("submit");
      return Promise.resolve(deriveSolanaSignature(bytes));
    }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getTransaction: vi.fn().mockResolvedValue({
      slot: 1,
      meta: { err: null, computeUnitsConsumed: 1, fee: 5000 },
    }),
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
  };
  const manager = {
    executeWithFailover: vi.fn((op: (c: unknown) => unknown) => op(connection)),
  };
  const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
    Promise.resolve(manager as never)
  );
  return { adapter, connection };
}

function send(
  adapter: SolanaChainAdapter,
  beforeBroadcast?: TransactionOptions["beforeBroadcast"]
) {
  return adapter.sendTransaction(
    undefined as unknown as ethers.Signer,
    { to: Keypair.generate().publicKey.toBase58(), value: BigInt(5000) },
    undefined as unknown as NonceSession,
    {
      solanaSigner: new SolanaKeypairSigner(Keypair.generate()),
      gasOverrides: {},
      beforeBroadcast,
    }
  );
}

describe("SolanaChainAdapter.sendTransaction with a hook", () => {
  let order: string[];
  beforeEach(() => {
    order = [];
  });

  it("hands the hook the signature the transaction will carry, before submitting", async () => {
    const { adapter } = harness(order);
    const events: BroadcastEvent[] = [];

    const receipt = await send(adapter, (event) => {
      order.push("hook");
      events.push(event);
      return Promise.resolve();
    });

    expect(order).toEqual(["hook", "submit"]);
    expect(events).toEqual([
      { kind: "solana-signed", signature: receipt.hash },
    ]);
  });

  it("does not submit when the hook throws", async () => {
    const { adapter, connection } = harness(order);

    await expect(
      send(adapter, () => Promise.reject(new Error("db down")))
    ).rejects.toBeInstanceOf(BroadcastHookError);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("submits exactly as before without a hook", async () => {
    const { adapter, connection } = harness(order);

    await send(adapter);

    expect(order).toEqual(["submit"]);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
