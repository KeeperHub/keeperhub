import bundledDomains from "./auth-disposable-email-domains.json";

const CURATED_HEADLINE_DOMAINS: readonly string[] = [
  // Public-inbox / developer testing
  "mailinator.com",
  "yopmail.com",
  "maildrop.cc",
  "emailondeck.com",
  "disposablemail.com",
  // Time-limited inboxes
  "10minutemail.com",
  "10minutemail.net",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.biz",
  "guerrillamail.de",
  "sharklasers.com",
  "grr.la",
  "temp-mail.org",
  "temp-mail.io",
  "tempmail.com",
  "tempmail.net",
  // Long-retention disposable
  "mailnesia.com",
  "getnada.com",
  "nada.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.net",
  "dispostable.com",
  "fakemail.net",
  "fakemailgenerator.com",
  // Forwarding / privacy aliasing (block by default; remove from this list
  // if you decide to allow opaque aliases that still represent a real user)
  "simplelogin.com",
  "simplelogin.co",
  "simplelogin.fr",
  "addy.io",
  "anonaddy.me",
  "anonaddy.com",
  "relay.firefox.com",
  "mozmail.com",
  "duck.com",
  "burnermail.io",
  "ironvest.com",
  // Catch-all burner domains that mint a random subdomain per address
  "marchslurp.com",
  "roomsranked.com",
  "arcadehearth.com",
];

// Mainstream providers are never blocked, whatever the vendored list says, so
// a bad upstream refresh cannot lock real users out of sign-up.
export const NEVER_BLOCKED_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "fastmail.com",
  "tutanota.com",
  "hey.com",
];

const NEVER_BLOCKED: ReadonlySet<string> = new Set(NEVER_BLOCKED_DOMAINS);

const BLOCKED_DOMAINS: ReadonlySet<string> = new Set<string>(
  [
    ...CURATED_HEADLINE_DOMAINS.map((d) => d.toLowerCase()),
    ...(bundledDomains as readonly string[]).map((d) => d.toLowerCase()),
  ].filter((d) => !NEVER_BLOCKED.has(d))
);

function extractDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

export function isDisposableEmailDomain(email: string): boolean {
  const domain = extractDomain(email);
  if (!domain) {
    return false;
  }
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (BLOCKED_DOMAINS.has(labels.slice(i).join("."))) {
      return true;
    }
  }
  return false;
}

export function disposableEmailBlocklistSize(): number {
  return BLOCKED_DOMAINS.size;
}
