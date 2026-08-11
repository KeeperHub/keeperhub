import { expect, type Page } from "@playwright/test";
import { hexToBytes, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Injects a deterministic EIP-1193 / EIP-6963 wallet into the page so SIWE and
 * step-up flows can be exercised without a real browser extension. The provider
 * lives in the page; the actual secp256k1 signing happens in Node via viem
 * (exposed as `__khStubSign`) so we don't ship a signer into the browser.
 *
 * Both the SIWE login and the step-up/invite challenges call
 * `personal_sign([toHex(message), address])`, i.e. the message arrives hex
 * encoded. We sign the decoded raw bytes with the EIP-191 prefix, which is what
 * the server's `recoverMessageAddress({ message: <original string> })` expects.
 */

// Hardhat account #0 - a well-known throwaway key, never used for real funds.
export const TEST_WALLET_PRIVATE_KEY: `0x${string}` =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_WALLET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * Sign a step-up / invite challenge exactly as the stub wallet would for
 * `personal_sign([toHex(message), address])`. `signMessage({ message })` applies
 * the EIP-191 prefix over the utf8 bytes, which is what the server recovers
 * against. Use this to drive step-up at the API layer.
 */
export function signWithTestWallet(
  message: string,
  privateKey: `0x${string}` = TEST_WALLET_PRIVATE_KEY
): Promise<string> {
  return privateKeyToAccount(privateKey).signMessage({ message });
}

type StubOptions = {
  privateKey?: `0x${string}`;
  chainId?: number;
  rdns?: string;
  name?: string;
};

type InitArgs = {
  address: string;
  chainIdHex: string;
  rdns: string;
  name: string;
};

export async function installWalletStub(
  page: Page,
  opts: StubOptions = {}
): Promise<{ address: string }> {
  const account = privateKeyToAccount(
    opts.privateKey ?? TEST_WALLET_PRIVATE_KEY
  );
  const chainIdHex = `0x${(opts.chainId ?? 1).toString(16)}`;

  await page.exposeFunction(
    "__khStubSign",
    (param: string): Promise<string> =>
      account.signMessage({
        message: isHex(param) ? { raw: hexToBytes(param) } : param,
      })
  );

  await page.addInitScript(
    ({ address, chainIdHex: chainHex, rdns, name }: InitArgs) => {
      const sign = (
        window as unknown as { __khStubSign: (m: string) => Promise<string> }
      ).__khStubSign;

      const provider = {
        isMetaMask: true,
        request: ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }): Promise<unknown> => {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return Promise.resolve([address]);
            case "eth_chainId":
              return Promise.resolve(chainHex);
            case "net_version":
              return Promise.resolve(String(Number.parseInt(chainHex, 16)));
            case "personal_sign":
              return sign(String(params?.[0] ?? ""));
            default:
              return Promise.resolve(null);
          }
        },
        on: () => undefined,
        removeListener: () => undefined,
      };

      (window as unknown as { ethereum: unknown }).ethereum = provider;

      const info = {
        uuid: "11111111-2222-3333-4444-555555555555",
        name,
        icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>",
        rdns,
      };
      const announce = (): void => {
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          })
        );
      };
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    {
      address: account.address,
      chainIdHex,
      rdns: opts.rdns ?? "io.metamask",
      name: opts.name ?? "MetaMask",
    }
  );

  return { address: account.address };
}

/**
 * Full SIWE sign-in via the stub: open Connect, pick the injected wallet, sign,
 * and clear the first-login display-name modal. Assumes `installWalletStub` ran
 * and the page is logged out. Leaves the page signed in and in-app.
 */
export async function completeWalletLogin(page: Page): Promise<void> {
  await page.goto("/welcome", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Wallet" }).click();
  await page.getByTestId("connect-wallet-io.metamask").click();

  // SIWE login mints the session and redirects into the app (the onboarding
  // wizard for a new account). Wait until we leave the landing, then mark
  // onboarding complete so helper-based tests land straight in-app. The proxy's
  // CSRF guard rejects state-changing POSTs without an Origin header, so pass
  // one explicitly or the complete call 403s and the wizard redirect persists.
  await page.waitForURL((url) => !url.pathname.endsWith("/welcome"), {
    timeout: 20_000,
  });
  await page.request.post("/api/user/onboarding/complete", {
    headers: { Origin: new URL(page.url()).origin },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });
}
