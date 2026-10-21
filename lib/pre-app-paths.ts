/**
 * The welcome landing and its onboarding wizard (/welcome, /welcome/create-org,
 * ...). They are full-screen, built for phones, and shown before the visitor is
 * in the app, so the app shell, the getting-started guide and the desktop
 * warning all stay out of them.
 */
export function isWelcomePath(pathname: string): boolean {
  return pathname === "/welcome" || pathname.startsWith("/welcome/");
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
