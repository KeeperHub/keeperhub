/**
 * The route itself or a page under it: "/welcome" and "/welcome/create-org",
 * but not "/welcome-back".
 */
export function isUnderRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/**
 * The welcome landing and its onboarding wizard (/welcome, /welcome/create-org,
 * ...). They are full-screen, built for phones, and shown before the visitor is
 * in the app, so the app shell, the getting-started guide and the desktop
 * warning all stay out of them.
 */
export function isWelcomePath(pathname: string): boolean {
  return isUnderRoute(pathname, "/welcome");
}

/**
 * The second-factor gates a sign-in can land on before the app: verifying a
 * code, or setting up two-factor because the account or its organization
 * requires it.
 */
export const MFA_GATE_PATHS: ReadonlySet<string> = new Set([
  "/verify-mfa",
  "/enroll-mfa",
  "/enforce-mfa",
]);

/**
 * Every check a sign-in can stop at before the app: the second-factor gates,
 * plus confirming a sign-in from a new network.
 */
export const SIGN_IN_GATE_PATHS: ReadonlySet<string> = new Set([
  ...MFA_GATE_PATHS,
  "/verify-ip",
]);

export function isSignInGatePath(pathname: string): boolean {
  for (const gate of SIGN_IN_GATE_PATHS) {
    if (isUnderRoute(pathname, gate)) {
      return true;
    }
  }
  return false;
}

// Pages a visitor opens from outside the app and signs in on: an invite
// link, a device approval, an OAuth client asking for access. Each is a
// full-screen card of its own.
const LINKED_SIGN_IN_ROUTES: readonly string[] = [
  "/accept-invite",
  "/device",
  "/oauth/authorize",
];

export function isLinkedSignInPath(pathname: string): boolean {
  return LINKED_SIGN_IN_ROUTES.some((route) => isUnderRoute(pathname, route));
}

/**
 * Every page a visitor can be on before they are in the app: the welcome
 * pages, the sign-in checks and the pages they sign in on from a link. The
 * getting-started guide and the desktop warning stay out of all of them.
 */
export function isPreAppPath(pathname: string): boolean {
  return (
    isWelcomePath(pathname) ||
    isSignInGatePath(pathname) ||
    isLinkedSignInPath(pathname)
  );
}
