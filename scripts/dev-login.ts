#!/usr/bin/env tsx

/**
 * dev-login.ts
 *
 * One-shot local-dev sign-in. Composes four steps so the caller only
 * needs `pnpm dev:login`:
 *   1. pnpm dev:bootstrap                (idempotent, ~2s when warm)
 *   2. KEEPERHUB_DEV_MINT=1 dev-mint-cookie  (writes the signed cookie file)
 *   3. ensure a dev server is serving http://localhost:3000 -- reuse one
 *      if it is already up, otherwise spawn `pnpm dev` detached (logging to
 *      .claude/.dev-server-LOCAL.log) and wait until it responds.
 *   4. seed the cookie into a Chromium persistent profile under
 *      .claude/.dev-chrome-profile/ and launch Chromium detached against
 *      the now-serving URL.
 *
 * Step 3 is what makes this a true single command: without it the browser
 * opens onto a connection-refused page whenever the dev server is not
 * already running.
 *
 * The Chromium instance is separate from the user's normal Chrome (its
 * own user-data-dir), so it doesn't disturb their working tabs. The
 * profile dir and the server log are gitignored. Re-running dev:login just
 * refreshes the cookie and reuses the running server, so the user can keep
 * the window open across sessions if they want.
 *
 * Hostname guard: refuses to run unless DATABASE_URL resolves to a local
 * Postgres. KEEPERHUB_DEV_MINT is set for the mint child process here,
 * because invoking dev:login is itself the explicit acknowledgment of
 * "yes, mint a forged session" -- the hostname guard is the bulletproof
 * safety check, the env var is belt-and-suspenders for direct invocation
 * of dev:mint-cookie.
 */

import { sleep } from "@/lib/sleep";
import "dotenv/config";

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { getDatabaseUrl } from "../lib/db/connection-utils";

const ALLOWED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "db",
  "postgres",
]);

const REPO_ROOT = process.cwd();
const COOKIE_FILE = path.join(
  REPO_ROOT,
  ".claude",
  ".dev-session-cookie-LOCAL"
);
const CHROME_PROFILE_DIR = path.join(
  REPO_ROOT,
  ".claude",
  ".dev-chrome-profile"
);
const DEV_SERVER_LOG = path.join(
  REPO_ROOT,
  ".claude",
  ".dev-server-LOCAL.log"
);
const DEV_URL = process.env.DEV_LOGIN_URL ?? "http://localhost:3000";
const SERVER_READY_TIMEOUT_MS = 180_000;
const SERVER_POLL_INTERVAL_MS = 1000;
const SERVER_PROBE_TIMEOUT_MS = 2000;

function assertLocalDb(): void {
  const url = getDatabaseUrl();
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error("dev-login: DATABASE_URL is not a parseable URL");
  }
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `dev-login: refusing to run against host "${hostname}". Only ${[
        ...ALLOWED_HOSTS,
      ].join(", ")} are allowed.`
    );
  }
}

function parseEmail(): string {
  return process.argv[2] ?? "dev@keeperhub.local";
}

function runStep(
  label: string,
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): void {
  console.log(`> ${label}`);
  const env = { ...process.env, ...extraEnv } as NodeJS.ProcessEnv;
  const result = spawnSync("pnpm", ["tsx", script, ...args], {
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status ?? "null"}`);
  }
}

function probeServer(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      // Any HTTP response means something is listening and serving.
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(SERVER_PROBE_TIMEOUT_MS, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startDevServerDetached(): void {
  const logFd = fs.openSync(DEV_SERVER_LOG, "a");
  try {
    const child = spawn("pnpm", ["dev"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: REPO_ROOT,
      env: process.env,
    });
    child.unref();
  } finally {
    // The child has its own dup'd descriptor for stdout/stderr; close the
    // parent's copy so we don't leak it for the parent's remaining lifetime.
    fs.closeSync(logFd);
  }
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeServer(url)) {
      return;
    }
    await sleep(SERVER_POLL_INTERVAL_MS);
  }
  throw new Error(
    `dev-login: dev server did not become ready within ${
      SERVER_READY_TIMEOUT_MS / 1000
    }s. Check ${DEV_SERVER_LOG}.`
  );
}

async function ensureDevServer(): Promise<void> {
  if (await probeServer(DEV_URL)) {
    console.log(`> dev server already running at ${DEV_URL}`);
    return;
  }
  console.log(`> starting dev server (logs: ${DEV_SERVER_LOG})`);
  startDevServerDetached();
  console.log("> waiting for dev server to be ready...");
  await waitForServer(DEV_URL);
  console.log("> dev server ready");
}

function readCookieValue(): string {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(
      `dev-login: cookie file not found at ${COOKIE_FILE}. The mint step did not produce it.`
    );
  }
  const text = fs.readFileSync(COOKIE_FILE, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    return trimmed;
  }
  throw new Error(`dev-login: ${COOKIE_FILE} has no cookie line`);
}

function launchBrowserDetached(rawSignedValue: string): void {
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  // Spawn the browser owner as a detached child. We can't seed cookies in
  // this parent process and then point a separate Chromium at the same
  // profile -- Playwright's addCookies() in headless mode doesn't reliably
  // flush HttpOnly cookies to disk before the context closes, so the
  // newly-spawned Chromium would see an empty cookie store. Keeping the
  // browser inside a Playwright context (in a separate Node process)
  // sidesteps the persistence race entirely.
  // Pass the signed cookie (a live bearer credential) via env, not argv:
  // process argv is world-readable via ps / /proc/<pid>/cmdline, whereas
  // /proc/<pid>/environ is owner-only. URL and profile dir are not secret,
  // so they stay as positional args.
  const child = spawn(
    "pnpm",
    [
      "tsx",
      path.join("scripts", "dev-login-browser.ts"),
      DEV_URL,
      CHROME_PROFILE_DIR,
    ],
    {
      detached: true,
      stdio: "ignore",
      cwd: REPO_ROOT,
      env: { ...process.env, KEEPERHUB_DEV_COOKIE: rawSignedValue },
    }
  );
  child.unref();
}

async function main(): Promise<void> {
  assertLocalDb();
  const email = parseEmail();

  runStep("pnpm dev:bootstrap", "scripts/seed/dev-bootstrap.ts", []);
  runStep(
    `pnpm dev:mint-cookie ${email}`,
    "scripts/dev-mint-session.ts",
    [email],
    { KEEPERHUB_DEV_MINT: "1" }
  );

  await ensureDevServer();

  const cookie = readCookieValue();
  console.log(`> launching detached Chromium at ${DEV_URL}`);
  launchBrowserDetached(cookie);

  console.log("\ndev-login: signed-in Chromium window opening.");
  console.log(`  Profile: ${CHROME_PROFILE_DIR}`);
  console.log("  Re-run pnpm dev:login any time to refresh the cookie.");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
