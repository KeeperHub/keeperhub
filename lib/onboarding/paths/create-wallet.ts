import "driver.js/dist/driver.css";
import type { Driver } from "driver.js";
import { waitForAnchor } from "@/lib/onboarding/wait-for-anchor";

const CREATE_WALLET_BUTTON = '[data-tour="create-wallet"]';
const CREATE_WALLET_FORM = '[data-tour="create-wallet-form"]';
const WALLET_ADDRESS = '[data-testid="wallet-toolbar-address"]';

// The user has to click the highlighted button to open the overlay, so give
// them room before giving up; Turnkey provisioning then takes a few seconds.
const OPEN_OVERLAY_TIMEOUT_MS = 60_000;
const WALLET_CREATED_TIMEOUT_MS = 120_000;

export type CreateWalletPathResult = "done" | "skipped";

/**
 * Standalone onboarding sub-path that guides an org admin through creating their
 * Turnkey wallet. It depends only on always-present toolbar chrome (the
 * "Create wallet" button), so it can run on its own or be awaited by another
 * tour (e.g. the editor walkthrough) when a wallet is required but missing.
 *
 * Steps advance off DOM/async events, not button clicks: highlight the toolbar
 * button -> wait for the overlay's create form -> wait for the new wallet to
 * appear in the toolbar -> close the overlay. Resolves "done" once the wallet
 * exists, or "skipped" if the user closes the tour or the flow stalls. The
 * caller owns admin gating - only run this when the user can actually create a
 * wallet, otherwise the overlay shows a non-admin dead-end and this just stalls.
 */
export async function runCreateWalletPath(opts: {
  signal: AbortSignal;
  closeOverlays: () => void;
}): Promise<CreateWalletPathResult> {
  const { signal, closeOverlays } = opts;

  const button = await waitForAnchor(CREATE_WALLET_BUTTON, signal);
  if (signal.aborted || !button) {
    return "skipped";
  }

  const { driver } = await import("driver.js");
  if (signal.aborted) {
    return "skipped";
  }

  return await new Promise<CreateWalletPathResult>((resolve) => {
    let settled = false;
    const settle = (result: CreateWalletPathResult, instance: Driver): void => {
      if (settled) {
        return;
      }
      settled = true;
      instance.destroy();
      resolve(result);
    };

    const instance = driver({
      allowClose: true,
      showProgress: false,
      onDestroyed: () => {
        // Fires when the user closes the tour (the steps have no done button).
        if (!settled) {
          settled = true;
          resolve("skipped");
        }
      },
      steps: [
        {
          element: CREATE_WALLET_BUTTON,
          popover: {
            title: "Create your wallet",
            description:
              "You'll need an organization wallet to check a balance. Click Create wallet to provision one - it's secured by Turnkey.",
            side: "bottom",
            align: "end",
            showButtons: ["close"],
          },
        },
        {
          element: CREATE_WALLET_FORM,
          popover: {
            title: "Name and create it",
            description:
              "Enter an email to identify the wallet, then click Create Wallet. We'll carry on once it's ready.",
            side: "left",
            align: "start",
            showButtons: ["close"],
          },
        },
      ],
    });

    instance.drive();

    (async () => {
      // The overlay's create form mounting is the cue that step 1 is done.
      const form = await waitForAnchor(
        CREATE_WALLET_FORM,
        signal,
        OPEN_OVERLAY_TIMEOUT_MS
      );
      if (settled) {
        return;
      }
      if (signal.aborted || !form) {
        settle("skipped", instance);
        return;
      }
      instance.moveNext();

      // The new wallet showing in the toolbar is the cue that creation finished.
      const created = await waitForAnchor(
        WALLET_ADDRESS,
        signal,
        WALLET_CREATED_TIMEOUT_MS
      );
      if (settled) {
        return;
      }
      if (signal.aborted || !created) {
        settle("skipped", instance);
        return;
      }
      closeOverlays();
      settle("done", instance);
    })().catch(() => settle("skipped", instance));
  });
}
