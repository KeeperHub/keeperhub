import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockLogSystemError = vi.fn();
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "EXTERNAL_SERVICE" },
  logSystemError: (...args: unknown[]) => mockLogSystemError(...args),
}));

// Stub the real provisioning service so importing the module is side-effect
// free; every test injects its own `provision` via opts.
vi.mock("@/lib/turnkey/provision-org-wallet", () => ({
  provisionOrganizationWallet: vi.fn(),
}));

import {
  createProvisionWalletStreamStart,
  type ProvisionStreamEvent,
} from "@/lib/turnkey/provision-wallet-stream";

const INPUT = {
  userId: "user-1",
  organizationId: "org-1",
  email: "new@example.com",
};

async function collectEvents(
  start: (controller: ReadableStreamDefaultController<Uint8Array>) => void
): Promise<ProvisionStreamEvent[]> {
  const stream = new ReadableStream<Uint8Array>({ start });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: ProvisionStreamEvent[] = [];
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const dataLine = buffer
        .slice(0, separator)
        .split("\n")
        .find((line) => line.startsWith("data:"));
      buffer = buffer.slice(separator + 2);
      if (dataLine) {
        events.push(
          JSON.parse(dataLine.slice(5).trim()) as ProvisionStreamEvent
        );
      }
      separator = buffer.indexOf("\n\n");
    }
  }

  return events;
}

describe("createProvisionWalletStreamStart", () => {
  beforeEach(() => {
    mockLogSystemError.mockClear();
  });

  it("emits provisioning then ready and closes on success", async () => {
    const provision = vi
      .fn()
      .mockResolvedValue({ walletAddress: "0xabc", created: true });

    const events = await collectEvents(
      createProvisionWalletStreamStart({
        signal: new AbortController().signal,
        input: INPUT,
        provision,
      })
    );

    expect(provision).toHaveBeenCalledWith(INPUT);
    expect(events).toEqual([
      { type: "provisioning" },
      { type: "ready", walletAddress: "0xabc", created: true },
    ]);
    expect(mockLogSystemError).not.toHaveBeenCalled();
  });

  it("emits provisioning then error and logs when provisioning throws", async () => {
    const provision = vi.fn().mockRejectedValue(new Error("turnkey down"));

    const events = await collectEvents(
      createProvisionWalletStreamStart({
        signal: new AbortController().signal,
        input: INPUT,
        provision,
      })
    );

    expect(events).toEqual([
      { type: "provisioning" },
      { type: "error", message: "Wallet provisioning failed" },
    ]);
    expect(mockLogSystemError).toHaveBeenCalledTimes(1);
  });

  it("keeps provisioning running after an early client abort", async () => {
    const controller = new AbortController();
    let resolveProvision: (value: {
      walletAddress: string;
      created: boolean;
    }) => void = () => undefined;
    const provision = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveProvision = resolve;
      })
    );

    const events = await collectEvents((streamController) => {
      const start = createProvisionWalletStreamStart({
        signal: controller.signal,
        input: INPUT,
        provision,
      });
      start(streamController);
      // Client disconnects before Turnkey responds.
      controller.abort();
      // Upstream call still completes; we just no longer report it.
      resolveProvision({ walletAddress: "0xabc", created: true });
    });

    expect(provision).toHaveBeenCalledWith(INPUT);
    // The stream was closed by the abort; only the initial frame made it out.
    expect(events).toEqual([{ type: "provisioning" }]);
  });
});
