/**
 * Regenerates lib/auth-disposable-email-domains.json from the upstream
 * disposable-domain lists. The disposable-email-domains-refresh workflow
 * downloads the lists and runs this weekly; it can also be run by hand.
 *
 * Refuses to write when the merged list shrinks sharply (a truncated or
 * failed download) so a bad fetch never weakens the sign-up check.
 *
 * Usage: tsx scripts/update-disposable-email-domains.ts <list.txt...>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEVER_BLOCKED_DOMAINS } from "../lib/auth-disposable-emails";

const OUTPUT_PATH = join(
  import.meta.dirname,
  "..",
  "lib",
  "auth-disposable-email-domains.json"
);
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MIN_KEEP_RATIO = 0.9;

function readDomains(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function main(): void {
  const sources = process.argv.slice(2);
  if (sources.length === 0) {
    process.stderr.write(
      "usage: tsx scripts/update-disposable-email-domains.ts <list.txt...>\n"
    );
    process.exit(2);
  }

  const neverBlocked = new Set(NEVER_BLOCKED_DOMAINS);
  const merged = new Set<string>();
  for (const source of sources) {
    for (const domain of readDomains(source)) {
      if (DOMAIN_RE.test(domain) && !neverBlocked.has(domain)) {
        merged.add(domain);
      }
    }
  }

  const current = JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as string[];
  if (merged.size < current.length * MIN_KEEP_RATIO) {
    process.stderr.write(
      `refusing to write: merged list has ${merged.size} domains, current has ${current.length}\n`
    );
    process.exit(1);
  }

  const next = [...merged].sort();
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(
    `wrote ${next.length} domains (was ${current.length})\n`
  );
}

main();
