/**
 * The pre-broadcast hook's contract, at every shared send path that runs it.
 *
 * A hook that could be bypassed would be worse than none: a caller would read
 * "the hook never fired" as "nothing was sent" for a transaction that left.
 * So each path is checked for three things: the hook runs before the
 * broadcast, a throwing hook stops the broadcast, and a hook that has not
 * resolved yet holds the broadcast back.
 */
import { ethers } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: () => Promise.resolve() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ explorerConfigs: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "",
  getTransactionUrl: () => "",
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  type BroadcastEvent,
  BroadcastHookError,
  isBroadcastHookError,
  runBroadcastHook,
} from "@/lib/web3/broadcast-hook";
import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { submitSignedTransactionWithFailover } from "@/lib/web3/submit-signed";

const TX_REQUEST: ethers.TransactionRequest = {
  to: "0x000000000000000000000000000000000000dEaD",
  nonce: 3,
  value: BigInt(1),
  gasLimit: BigInt(21_000),
  maxFeePerGas: BigInt(10_000_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000_000),
  chainId: 1,
  type: 2,
};

let SIGNED_HEX: string;
let EXPECTED_HASH: string;

beforeAll(async () => {
  const wallet = new ethers.Wallet(`0x${"2".repeat(64)}`);
  SIGNED_HEX = await wallet.signTransaction(TX_REQUEST);
  EXPECTED_HASH = ethers.Transaction.from(SIGNED_HEX).hash as string;
});

function signer(): ethers.Signer {
  return {
    populateTransaction: vi.fn().mockResolvedValue(TX_REQUEST),
    signTransaction: vi.fn().mockResolvedValue(SIGNED_HEX),
  } as unknown as ethers.Signer;
}

function manager(broadcastTransaction: ReturnType<typeof vi.fn>) {
  return {
    executeWithFailover: vi.fn(
      async (op: (p: ethers.JsonRpcProvider) => Promise<unknown>) =>
        await op({
          broadcastTransaction,
          getTransactionReceipt: vi.fn().mockResolvedValue(null),
          getTransaction: vi.fn().mockResolvedValue(null),
        } as unknown as ethers.JsonRpcProvider)
    ),
  } as unknown as RpcProviderManager;
}

describe("runBroadcastHook", () => {
  it("is a no-op without a hook", async () => {
    await expect(
      runBroadcastHook(undefined, { kind: "sponsored-submitting" })
    ).resolves.toBeUndefined();
  });

  it("wraps a throw so no caller can mistake it for a pre-broadcast failure", async () => {
    const cause = new Error("db down");
    const run = runBroadcastHook(() => Promise.reject(cause), {
      kind: "evm-signed",
      transactionHash: "0x1",
    });
    await expect(run).rejects.toBeInstanceOf(BroadcastHookError);
    const error = await run.catch((e: unknown) => e);
    expect(isBroadcastHookError(error)).toBe(true);
    expect((error as BroadcastHookError).eventKind).toBe("evm-signed");
    expect((error as Error).cause).toBe(cause);
  });
});

describe("submitSignedTransactionWithFailover with a hook", () => {
  it("hands the hook the final hash before broadcasting", async () => {
    const order: string[] = [];
    const broadcast = vi.fn(() => {
      order.push("broadcast");
      return Promise.resolve({ hash: EXPECTED_HASH });
    });
    const events: BroadcastEvent[] = [];

    const result = await submitSignedTransactionWithFailover(
      signer(),
      TX_REQUEST,
      manager(broadcast),
      (event) => {
        order.push("hook");
        events.push(event);
        return Promise.resolve();
      }
    );

    expect(order).toEqual(["hook", "broadcast"]);
    expect(events).toEqual([
      { kind: "evm-signed", transactionHash: EXPECTED_HASH },
    ]);
    expect(result.hash).toBe(EXPECTED_HASH);
  });

  it("does not broadcast when the hook throws", async () => {
    const broadcast = vi.fn();

    await expect(
      submitSignedTransactionWithFailover(
        signer(),
        TX_REQUEST,
        manager(broadcast),
        () => Promise.reject(new Error("write failed"))
      )
    ).rejects.toBeInstanceOf(BroadcastHookError);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("holds the broadcast until a slow hook resolves", async () => {
    const broadcast = vi.fn().mockResolvedValue({
      hash: "0xunused",
    } as unknown as ethers.TransactionResponse);
    let release: () => void = () => undefined;
    const pending = submitSignedTransactionWithFailover(
      signer(),
      TX_REQUEST,
      manager(broadcast),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    // Give every microtask and timer a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broadcast).not.toHaveBeenCalled();

    release();
    await pending;
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("broadcasts exactly as before when no hook is given", async () => {
    const broadcast = vi.fn().mockResolvedValue({ hash: EXPECTED_HASH });

    const result = await submitSignedTransactionWithFailover(
      signer(),
      TX_REQUEST,
      manager(broadcast)
    );

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(broadcast).toHaveBeenCalledWith(SIGNED_HEX);
  });
});

describe("EvmChainAdapter with a hook", () => {
  function adapterWithLegacySigner() {
    const provider = {
      call: vi.fn().mockResolvedValue("0x"),
      estimateGas: vi.fn().mockResolvedValue(BigInt(21_000)),
    };
    const sendTransaction = vi.fn();
    const legacySigner = {
      getAddress: vi
        .fn()
        .mockResolvedValue("0x2c9F694183A4240B6431771F6c714a8106179dF5"),
      provider,
      sendTransaction,
    };
    const adapter = new EvmChainAdapter(
      1,
      {
        getGasConfig: vi.fn().mockResolvedValue({
          gasLimit: BigInt(21_000),
          maxFeePerGas: BigInt(1),
          maxPriorityFeePerGas: BigInt(1),
        }),
      } as unknown as ConstructorParameters<typeof EvmChainAdapter>[1],
      {
        getNextNonce: vi.fn().mockReturnValue(0),
      } as unknown as ConstructorParameters<typeof EvmChainAdapter>[2]
    );
    return { adapter, legacySigner, sendTransaction };
  }

  // Without an rpcManager ethers signs and broadcasts in one call, so there is
  // no point at which the hook could run first.
  it("refuses a hook on the path that cannot run it", async () => {
    const { adapter, legacySigner, sendTransaction } =
      adapterWithLegacySigner();

    await expect(
      adapter.sendTransaction(
        legacySigner as unknown as ethers.Signer,
        { to: "0x000000000000000000000000000000000000dEaD", value: BigInt(1) },
        {} as Parameters<EvmChainAdapter["sendTransaction"]>[2],
        { gasOverrides: {}, beforeBroadcast: () => Promise.resolve() }
      )
    ).rejects.toBeInstanceOf(BroadcastHookError);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe("resolveSponsoredSendError and a failed hook", () => {
  // The sponsored path must not fall back to direct signing: that would send
  // without the record the hook exists to write.
  it("never falls back", () => {
    const decision = resolveSponsoredSendError(
      new BroadcastHookError("sponsored-submitting", new Error("db down")),
      { logPrefix: "[Test]", actionName: "transfer-token", chainId: 1 }
    );

    expect(decision).toMatchObject({
      fallback: false,
      errorClass: ExecutionErrorType.SYSTEM,
    });
  });
});
