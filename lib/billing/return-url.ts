/**
 * Where the billing provider sends the user back after the portal.
 *
 * The path arrives from the browser, so only same-origin paths are honoured:
 * anything else would turn the portal into an open redirect.
 */
export function resolveReturnUrl(appUrl: string, returnPath: unknown): string {
  const fallback = `${appUrl}/billing`;
  if (typeof returnPath !== "string" || !returnPath.startsWith("/")) {
    return fallback;
  }
  try {
    const target = new URL(returnPath, appUrl);
    if (target.origin !== new URL(appUrl).origin) {
      return fallback;
    }
    return `${target.origin}${target.pathname}${target.search}`;
  } catch {
    return fallback;
  }
}
