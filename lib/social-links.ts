/**
 * Canonical KeeperHub community + support links. Single source of truth so the
 * contact-support surface, emails, and nav don't drift (they previously did --
 * e.g. lib/email.ts carried a stale Telegram invite). Seeded from the public
 * links page (../landing/src/app/links/links-content.tsx).
 */

export type SocialBrand =
  | "discord"
  | "telegram"
  | "x"
  | "youtube"
  | "linkedin"
  | "docs"
  | "status";

export type SocialLink = {
  label: string;
  href: string;
  brand: SocialBrand;
};

/**
 * Address users can email for support.
 *
 * Deliberately not configurable. The only consumer,
 * `components/support/contact-support-dialog.tsx`, is a client component, so a
 * NEXT_PUBLIC_ read here would be inlined at build time and a deployment
 * running a prebuilt image could never change it. A seam that cannot be used
 * is worse than an honest constant: see DEPENDENCIES.md, which lists this and
 * the links below among the things a deployment still shows KeeperHub for.
 */
export const SUPPORT_EMAIL = "human@keeperhub.com";

/** Community + resource links, ordered most-direct-help first. */
export const SOCIAL_LINKS: readonly SocialLink[] = [
  { label: "Discord", href: "https://discord.gg/keeperhub", brand: "discord" },
  {
    label: "Telegram",
    href: "https://t.me/+pHqeV_UtG1I0ZTY0",
    brand: "telegram",
  },
  { label: "X", href: "https://x.com/KeeperHubApp", brand: "x" },
  {
    label: "YouTube",
    href: "https://www.youtube.com/@KeeperHub",
    brand: "youtube",
  },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/company/keeperhub",
    brand: "linkedin",
  },
  { label: "Docs", href: "https://docs.keeperhub.com", brand: "docs" },
  { label: "Status", href: "https://status.keeperhub.com/", brand: "status" },
] as const;
