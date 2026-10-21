/**
 * The welcome landing and its onboarding wizard (/welcome, /welcome/create-org,
 * ...). They are full-screen, built for phones, and shown before the visitor is
 * in the app, so the app shell, the getting-started guide and the desktop
 * warning all stay out of them.
 */
export function isWelcomePath(pathname: string): boolean {
  return pathname === "/welcome" || pathname.startsWith("/welcome/");
}
