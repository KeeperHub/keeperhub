/**
 * Public identity this deployment publishes on its agent-facing surfaces: the
 * trust-anchor pages (/about, /contact, /privacy), the homepage JSON-LD, and
 * the markdown variants served under Accept negotiation.
 *
 * Same contract as lib/agent-identity.ts, for the same reason. Every default
 * below is KeeperHub's own, so a deployment that configures nothing publishes
 * exactly what it published before this module existed. Values that cannot be
 * defaulted truthfully - a postal address above all - are omitted entirely
 * rather than guessed: an Organization record carrying somebody else's address
 * is a worse legitimacy signal than one carrying none.
 *
 * Server-only by construction. Every read is a bare `process.env` lookup, which
 * a client bundle would inline as `undefined`; the callers are server
 * components, metadata routes, and the proxy.
 */

const TRAILING_SLASH = /\/+$/;

const DEFAULT_APP_URL = "https://app.keeperhub.com";
const DEFAULT_MARKETING_URL = "https://keeperhub.com";
const DEFAULT_DOCS_URL = "https://docs.keeperhub.com";
/**
 * The two mailboxes the marketing site publishes, mapped to the same roles it
 * gives them: `human@` is the contactType "customer support" on its Organization
 * node, `support@` is the address its privacy policy names for data-subject
 * requests. Both are real; mirroring the split keeps the two sites from
 * publishing different contact details for one company.
 */
const DEFAULT_SUPPORT_EMAIL = "human@keeperhub.com";
const DEFAULT_PRIVACY_EMAIL = "support@keeperhub.com";

/** Matches the marketing site's own Organization node. See sameAs below. */
const DEFAULT_FOUNDING_DATE = "2025";

function trimTrailingSlash(value: string): string {
  return value.replace(TRAILING_SLASH, "");
}

function envUrl(key: string, fallback: string): string {
  const raw = process.env[key]?.trim();
  return trimTrailingSlash(raw && raw.length > 0 ? raw : fallback);
}

/** The origin this deployment is reached on. */
export function appUrl(): string {
  return envUrl("NEXT_PUBLIC_APP_URL", DEFAULT_APP_URL);
}

/** The marketing site that owns the canonical brand entity. */
export function marketingUrl(): string {
  return envUrl("SITE_MARKETING_URL", DEFAULT_MARKETING_URL);
}

/** The documentation site, which also hosts the canonical llms.txt. */
export function docsUrl(): string {
  return envUrl("DOCS_BASE_URL", DEFAULT_DOCS_URL);
}

export function supportEmail(): string {
  const raw = process.env.SITE_SUPPORT_EMAIL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SUPPORT_EMAIL;
}

/** Privacy / data-subject-request mailbox. See DEFAULT_PRIVACY_EMAIL above. */
export function privacyEmail(): string {
  const raw = process.env.SITE_PRIVACY_EMAIL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_PRIVACY_EMAIL;
}

export function foundingDate(): string {
  const raw = process.env.SITE_FOUNDING_DATE?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_FOUNDING_DATE;
}

export type PostalAddress = {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry: string;
};

/** KeeperHub's registered address. Withheld from forks - see postalAddress(). */
const DEFAULT_ADDRESS: PostalAddress = {
  streetAddress: "Ahtri 12",
  addressLocality: "Tallinn",
  addressRegion: "Harju maakond",
  // ISO 3166-1 alpha-2, which is what consumers of schema.org/addressCountry
  // parse; "Estonia" is accepted but not machine-normalised.
  addressCountry: "EE",
  postalCode: "10151",
};

/**
 * The registered postal address, or null when this deployment has nothing
 * truthful to publish.
 *
 * The coherence guard is the point of the fallback, and it mirrors
 * onChainIdentity() in lib/agent-identity.ts. A deployment that overrides
 * SITE_MARKETING_URL has declared "I am not KeeperHub" - and since the address
 * belongs to the entity named by organizationId(), which is derived from that
 * same URL, serving KeeperHub's address under a different company's identity
 * would be a plausible-looking lie in exactly the field a reader consults to
 * check the company is real. So it is withheld rather than inherited.
 *
 * SITE_ADDRESS_COUNTRY is what a fork sets to publish its own; the remaining
 * fields are optional, because a partial address (locality + country) is honest
 * where an invented street is not.
 */
export function postalAddress(): PostalAddress | null {
  const country = process.env.SITE_ADDRESS_COUNTRY?.trim();
  if (!country) {
    const renamed = Boolean(process.env.SITE_MARKETING_URL?.trim());
    return renamed ? null : DEFAULT_ADDRESS;
  }
  const optional = (key: string): string | undefined => {
    const raw = process.env[key]?.trim();
    return raw && raw.length > 0 ? raw : undefined;
  };
  return {
    streetAddress: optional("SITE_ADDRESS_STREET"),
    addressLocality: optional("SITE_ADDRESS_LOCALITY"),
    addressRegion: optional("SITE_ADDRESS_REGION"),
    postalCode: optional("SITE_ADDRESS_POSTAL_CODE"),
    addressCountry: country,
  };
}

/**
 * Expands an ISO 3166-1 alpha-2 code to its English country name, falling back
 * to the raw value when it is not a region code (a deployment may reasonably
 * have set addressCountry to a full name already).
 */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Renders a PostalAddress as a single human-readable line.
 *
 * Postal order, not schema.org field order: the postcode belongs next to the
 * locality ("10151 Tallinn"), and the country is spelled out, because "EE" is
 * the right value for schema.org/addressCountry and the wrong thing to show a
 * person reading a contact page.
 */
export function formatPostalAddress(address: PostalAddress): string {
  const locality = [address.postalCode, address.addressLocality]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return [
    address.streetAddress,
    locality.length > 0 ? locality : undefined,
    address.addressRegion,
    countryName(address.addressCountry),
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

const DEFAULT_SAME_AS: readonly string[] = [
  "https://x.com/KeeperHubApp",
  "https://www.linkedin.com/company/keeperhub/",
  "https://github.com/KeeperHub/keeperhub",
  "https://discord.gg/keeperhub",
  "https://www.youtube.com/@KeeperHub",
];

/**
 * Profiles that belong to the same entity. Comma-separated override so a
 * deployment can publish its own set; an explicitly empty value publishes none,
 * which is the right answer for a fork that owns no social profiles.
 */
export function sameAs(): readonly string[] {
  const raw = process.env.SITE_SAME_AS;
  if (raw === undefined) {
    return DEFAULT_SAME_AS;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The `@id` every JSON-LD node points at when naming the publisher.
 *
 * Deliberately the marketing origin, not this one. app.keeperhub.com and
 * keeperhub.com are one company, and the marketing site already publishes
 * `https://keeperhub.com/#organization`; reusing the id resolves both sites to
 * a single entity instead of inventing a second, thinner company record that
 * competes with it.
 */
export function organizationId(): string {
  return `${marketingUrl()}/#organization`;
}

export const KNOWS_ABOUT: readonly string[] = [
  "blockchain automation",
  "onchain AI agents",
  "Model Context Protocol",
  "x402 payment protocol",
  "DeFi keeper infrastructure",
];
