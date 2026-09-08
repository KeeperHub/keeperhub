#!/usr/bin/env tsx

/**
 * seed-internal-service-hmac.ts
 *
 * One-off seeder for the internal-service HMAC signing secret. Reads a base64
 * 32-byte secret from stdin and inserts it under (caller, key_version) = (?, ?)
 * using the same envelope encryption as agentic_wallet_hmac_secrets.
 *
 * For v1 every producer (executor, scheduler, events) shares one signing
 * secret stored under caller = "*shared*". Running this script with a different
 * `--caller` value seeds a per-producer secret for the future split.
 *
 * Usage:
 *   echo "<base64-32-bytes>" | pnpm tsx scripts/seed-internal-service-hmac.ts
 *   echo "<base64-32-bytes>" | pnpm tsx scripts/seed-internal-service-hmac.ts -- --caller executor --version 2
 *
 * The script refuses to run against a non-localhost DATABASE_URL unless
 * ALLOW_REMOTE=1 is set. The seed value should come from a freshly generated
 * random source; do not reuse the legacy KEEPERHUB_API_KEY.
 */

import { insertHmacSecret } from "@/lib/internal-service-hmac-store";

// Allow the docker-compose service hostnames (db/postgres) in addition to
// loopback, so the seed can run from inside the local dev stack. Mirrors the
// host allowlist used by the dev-login bootstrap scripts.
const LOCAL_HOST_PATTERN =
  /^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1|db|postgres):/;

function parseArgs(argv: string[]): { caller: string; version: number } {
  let caller = "*shared*";
  let version = 1;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--caller" && i + 1 < argv.length) {
      caller = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--version" && i + 1 < argv.length) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--version must be a positive integer");
      }
      version = n;
      i += 1;
    }
  }
  return { caller, version };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!LOCAL_HOST_PATTERN.test(dbUrl) && process.env.ALLOW_REMOTE !== "1") {
    throw new Error(
      "DATABASE_URL is not localhost. Set ALLOW_REMOTE=1 to seed against staging or prod."
    );
  }

  const { caller, version } = parseArgs(process.argv.slice(2));
  const secret = await readStdin();
  if (!secret) {
    throw new Error("No secret provided on stdin");
  }
  const decoded = Buffer.from(secret, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `Expected a 32-byte base64 secret on stdin; got ${decoded.length} bytes`
    );
  }

  await insertHmacSecret(caller, version, secret);
  process.stdout.write(
    `Seeded internal_service_hmac_secrets row caller=${caller} key_version=${version}\n`
  );
}

main()
  .then(() => {
    // Exit explicitly: the DB client keeps an open connection that would
    // otherwise keep the process (and a one-shot seed Job pod) alive forever.
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
