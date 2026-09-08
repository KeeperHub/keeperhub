import { afterEach, describe, expect, it, vi } from "vitest";

// The hook module is "use client" and pulls auth-client + wallet-info at import.
// We only exercise its pure test-seam exports, so stub those deps to keep the
// import hermetic in the node test environment.
vi.mock("@/lib/auth-client", () => ({
  useSession: vi.fn(),
  authClient: { useActiveOrganization: vi.fn() },
}));

vi.mock("@/lib/wallet/use-wallet-info", () => ({
  useWalletInfo: vi.fn(),
  useInvalidateWalletInfo: vi.fn(),
}));

import {
  __parseEventForTesting as parseEvent,
  __runProvisionStreamForTesting as runProvisionStream,
  __shouldOpenProvisionStreamForTesting as shouldOpenProvisionStream,
} from "@/lib/wallet/use-wallet-provisioning";

const BASE = {
  isAuthed: true,
  activeOrgId: "org-1",
  isLoading: false,
  hasWallet: false,
  attempted: false,
};

function sseFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("shouldOpenProvisionStream", () => {
  it("opens for a verified, org-scoped, wallet-less first attempt", () => {
    expect(shouldOpenProvisionStream(BASE)).toBe(true);
  });

  it("stays closed when unauthenticated, org-less, loading, already provisioned, or already attempted", () => {
    expect(shouldOpenProvisionStream({ ...BASE, isAuthed: false })).toBe(false);
    expect(shouldOpenProvisionStream({ ...BASE, activeOrgId: null })).toBe(
      false
    );
    expect(shouldOpenProvisionStream({ ...BASE, isLoading: true })).toBe(false);
    expect(shouldOpenProvisionStream({ ...BASE, hasWallet: true })).toBe(false);
    expect(shouldOpenProvisionStream({ ...BASE, attempted: true })).toBe(false);
  });
});

describe("parseEvent", () => {
  it("parses well-formed SSE data frames", () => {
    expect(parseEvent('data: {"type":"provisioning"}')).toEqual({
      type: "provisioning",
    });
    expect(
      parseEvent(
        'data: {"type":"ready","walletAddress":"0xabc","created":true}'
      )
    ).toEqual({ type: "ready", walletAddress: "0xabc", created: true });
  });

  it("returns null for a frame with no data line or malformed JSON", () => {
    expect(parseEvent(": keep-alive comment")).toBeNull();
    expect(parseEvent("data: not-json")).toBeNull();
  });
});

describe("runProvisionStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes onReady once when a ready frame arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: streamFromChunks([
          sseFrame({ type: "provisioning" }),
          sseFrame({ type: "ready", walletAddress: "0xabc", created: true }),
        ]),
      })
    );
    const onReady = vi.fn();

    await runProvisionStream(onReady);

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("reassembles a ready frame split across two chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: streamFromChunks([
          'data: {"type":"ready","walletAddress":"0xa',
          'bc","created":true}\n\n',
        ]),
      })
    );
    const onReady = vi.fn();

    await runProvisionStream(onReady);

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onReady on an error-only stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: streamFromChunks([
          sseFrame({ type: "provisioning" }),
          sseFrame({ type: "error", message: "Wallet provisioning failed" }),
        ]),
      })
    );
    const onReady = vi.fn();

    await runProvisionStream(onReady);

    expect(onReady).not.toHaveBeenCalled();
  });

  it("returns early without onReady when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, body: null })
    );
    const onReady = vi.fn();

    await runProvisionStream(onReady);

    expect(onReady).not.toHaveBeenCalled();
  });
});
