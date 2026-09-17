/**
 * The pre-broadcast hook on the Turnkey sponsored path. Turnkey signs and
 * broadcasts on its side, so the events are about the request: before it is
 * made, once Turnkey has accepted it, and when Turnkey says it ended before
 * broadcast.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    EXTERNAL_SERVICE: "external_service",
    TRANSACTION: "transaction",
  },
  logSystemError: vi.fn(),
}));

const mockEthSend = vi.fn();
const mockGetStatus = vi.fn();

vi.mock("@/lib/turnkey/agentic-wallet", () => ({
  getTurnkeyClientForOrg: () => ({
    apiClient: () => ({
      ethSendTransaction: (...args: unknown[]) => mockEthSend(...args),
      getSendTransactionStatus: (...args: unknown[]) => mockGetStatus(...args),
    }),
  }),
}));

vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  toCaip2: (chainId: number) => `eip155:${chainId}`,
}));

import { TurnkeyRequestError } from "@turnkey/sdk-server";
import {
  type BroadcastEvent,
  BroadcastHookError,
} from "@/lib/web3/broadcast-hook";
import { SponsoredTxPendingError } from "@/lib/web3/turnkey-revert";
import { submitTurnkeySponsoredTransaction } from "@/lib/web3/turnkey-sponsored-tx";

const FAST_POLL = { timeoutMs: 40, intervalMs: 5 };

function params(onBroadcastEvent?: (e: BroadcastEvent) => Promise<void>) {
  return {
    subOrgId: "sub-org-test",
    walletAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    chainId: 11_155_111,
    to: "0x000000000000000000000000000000000000dead",
    onBroadcastEvent,
  };
}

function recorder() {
  const events: BroadcastEvent["kind"][] = [];
  const hook = vi.fn((event: BroadcastEvent) => {
    events.push(event.kind);
    return Promise.resolve();
  });
  return { events, hook };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitTurnkeySponsoredTransaction with a hook", () => {
  it("reports submitting, then accepted with the status id, before the hash", async () => {
    const order: string[] = [];
    mockEthSend.mockImplementation(() => {
      order.push("ethSendTransaction");
      return Promise.resolve({ sendTransactionStatusId: "sid-1" });
    });
    mockGetStatus.mockResolvedValue({
      txStatus: "INCLUDED",
      eth: { txHash: "0xhash" },
    });
    const seen: BroadcastEvent[] = [];

    const result = await submitTurnkeySponsoredTransaction(
      params((event) => {
        order.push(event.kind);
        seen.push(event);
        return Promise.resolve();
      })
    );

    expect(order).toEqual([
      "sponsored-submitting",
      "ethSendTransaction",
      "sponsored-accepted",
    ]);
    expect(seen[1]).toEqual({
      kind: "sponsored-accepted",
      sendTransactionStatusId: "sid-1",
    });
    expect(result).toEqual({
      txHash: "0xhash",
      sendTransactionStatusId: "sid-1",
    });
  });

  it("never asks Turnkey when the submitting hook throws", async () => {
    await expect(
      submitTurnkeySponsoredTransaction(
        params(() => Promise.reject(new Error("db down")))
      )
    ).rejects.toBeInstanceOf(BroadcastHookError);
    expect(mockEthSend).not.toHaveBeenCalled();
  });

  // The request already left, so nothing can be aborted. Falling back would
  // send a second transaction; the send is reported pending with its id.
  it("reports pending with the id when the accepted hook throws", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-2" });
    const hook = vi.fn((event: BroadcastEvent) =>
      event.kind === "sponsored-accepted"
        ? Promise.reject(new Error("db down"))
        : Promise.resolve()
    );

    const error = await submitTurnkeySponsoredTransaction(params(hook)).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(SponsoredTxPendingError);
    expect((error as SponsoredTxPendingError).sendTransactionStatusId).toBe(
      "sid-2"
    );
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it("reports not-broadcast on a definite Turnkey rejection", async () => {
    mockEthSend.mockRejectedValue(
      new TurnkeyRequestError({
        code: 7,
        message: "denied",
        details: null,
      })
    );
    const { events, hook } = recorder();

    const result = await submitTurnkeySponsoredTransaction(params(hook));

    expect(result).toBeNull();
    expect(events).toEqual(["sponsored-submitting", "sponsored-not-broadcast"]);
  });

  it("reports not-broadcast on a terminal status with no hash", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-3" });
    mockGetStatus.mockResolvedValue({ txStatus: "FAILED", eth: {} });
    const { events, hook } = recorder();

    const result = await submitTurnkeySponsoredTransaction(params(hook));

    expect(result).toBeNull();
    expect(events).toEqual([
      "sponsored-submitting",
      "sponsored-accepted",
      "sponsored-not-broadcast",
    ]);
  });

  // An undetermined outcome is not a pre-broadcast end, so it must not be
  // reported as one.
  it("does not report not-broadcast when the outcome is unknown", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-4" });
    mockGetStatus.mockResolvedValue({ txStatus: "BROADCASTING", eth: {} });
    const { events, hook } = recorder();

    await expect(
      submitTurnkeySponsoredTransaction(params(hook), FAST_POLL)
    ).rejects.toBeInstanceOf(SponsoredTxPendingError);
    expect(events).not.toContain("sponsored-not-broadcast");
  });

  it("does not report not-broadcast when the request itself failed ambiguously", async () => {
    mockEthSend.mockRejectedValue(new Error("socket hang up"));
    const { events, hook } = recorder();

    await expect(
      submitTurnkeySponsoredTransaction(params(hook))
    ).rejects.toBeInstanceOf(SponsoredTxPendingError);
    expect(events).toEqual(["sponsored-submitting"]);
  });
});
