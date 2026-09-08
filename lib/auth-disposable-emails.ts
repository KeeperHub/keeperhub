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
];

const BLOCKED_DOMAINS: ReadonlySet<string> = new Set<string>([
  ...CURATED_HEADLINE_DOMAINS.map((d) => d.toLowerCase()),
  ...(bundledDomains as readonly string[]).map((d) => d.toLowerCase()),
]);

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
  return BLOCKED_DOMAINS.has(domain);
}

export function disposableEmailBlocklistSize(): number {
  return BLOCKED_DOMAINS.size;
}
