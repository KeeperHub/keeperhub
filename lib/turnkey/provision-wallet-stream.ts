import "server-only";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  type ProvisionWalletInput,
  provisionOrganizationWallet,
} from "@/lib/turnkey/provision-org-wallet";

/**
 * Events emitted over the wallet-provisioning SSE stream. The client opens the
 * stream right after signup; the connection stays open for the duration of the
 * upstream Turnkey call (the actual latency we are hiding), then reports the
 * result.
 */
export type ProvisionStreamEvent =
  | { type: "provisioning" }
  | { type: "ready"; walletAddress: string; created: boolean }
  | { type: "error"; message: string };

export type ProvisionWalletStreamOpts = {
  signal: AbortSignal;
  input: ProvisionWalletInput;
  // Injectable for tests; defaults to the real provisioning service.
  provision?: (input: ProvisionWalletInput) => Promise<{
    walletAddress: string;
    created: boolean;
  }>;
};

function formatSSE(event: ProvisionStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build the `start` callback for a one-shot wallet-provisioning ReadableStream.
 *
 * Emits `provisioning` immediately, awaits the Turnkey-backed
 * provisionOrganizationWallet (idempotent), then emits `ready` with the address
 * or `error` on failure, and closes. If the client aborts mid-flight the
 * provisioning promise is intentionally left running so the wallet still gets
 * created - we simply stop reporting. session.create.after backstops the rest.
 */
export function createProvisionWalletStreamStart(
  opts: ProvisionWalletStreamOpts
): (controller: ReadableStreamDefaultController<Uint8Array>) => void {
  const { signal, input, provision = provisionOrganizationWallet } = opts;

  return (controller): void => {
    const encoder = new TextEncoder();
    let closed = false;

    const onAbort = (): void => {
      safeClose();
    };

    function safeClose(): void {
      if (closed) {
        return;
      }
      closed = true;
      signal.removeEventListener("abort", onAbort);
      try {
        controller.close();
      } catch {
        // controller may already be closed by the platform
      }
    }

    const emit = (event: ProvisionStreamEvent): void => {
      if (closed) {
        return;
      }
      try {
        controller.enqueue(encoder.encode(formatSSE(event)));
      } catch {
        safeClose();
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });

    emit({ type: "provisioning" });

    provision(input)
      .then((result) => {
        emit({
          type: "ready",
          walletAddress: result.walletAddress,
          created: result.created,
        });
      })
      .catch((error: unknown) => {
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[Wallet] Stream provisioning failed at signup",
          error,
          { userId: input.userId, organizationId: input.organizationId }
        );
        emit({ type: "error", message: "Wallet provisioning failed" });
      })
      .finally(() => {
        safeClose();
      });
  };
}
