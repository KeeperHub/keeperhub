/**
 * Whether a URL points back at this application.
 *
 * Lives outside `lib/rpc/` on purpose. That directory is checked for the
 * hostnames we operate, because a KeeperHub host written there would become an
 * RPC or chain default that every deployment inherits. This is the opposite
 * use: recognising our own address so a link back into the product is not
 * mistaken for a provider endpoint and stripped.
 */
const DEFAULT_APP_URL = "https://app.keeperhub.com";

export function appOrigin(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL).origin;
  } catch {
    return new URL(DEFAULT_APP_URL).origin;
  }
}

/** True when `url` is served by this application rather than a third party. */
export function isOwnAppUrl(url: string): boolean {
  try {
    return new URL(url).origin === appOrigin();
  } catch {
    return false;
  }
}
