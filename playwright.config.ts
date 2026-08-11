import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { expand } from "dotenv-expand";

// Load and expand .env file for local development
expand(dotenv.config());

// Use BASE_URL env var for deployed environments, otherwise localhost
const baseURL = process.env.BASE_URL || "http://localhost:3000";
const isDeployedEnv = !!process.env.BASE_URL;

// Default DATABASE_URL for local docker-compose setup
const DEFAULT_DB_URL =
  "postgresql://postgres:postgres@localhost:5433/keeperhub";

function getDatabaseUrl(): string {
  const envDbUrl = process.env.DATABASE_URL;
  const hasUnexpandedVars = envDbUrl?.includes("${");
  if (!envDbUrl || hasUnexpandedVars) {
    return DEFAULT_DB_URL;
  }
  return envDbUrl;
}

const databaseUrl = getDatabaseUrl();

// Phase 45 BFCACHE-05: dual-mode webServer driven by NEXT_BUILD_MODE.
// `dev` (default) spawns `pnpm dev`. `production` spawns `pnpm build && pnpm start`
// — bumps webServer.timeout to 4 minutes to accommodate the build, and disables
// reuseExistingServer so a stale `pnpm start` from a previous run does not
// shadow the fresh build (45-RESEARCH.md Pitfall 3).
const nextBuildMode = process.env.NEXT_BUILD_MODE ?? "dev";
const isProdMode = nextBuildMode === "production";

// Set DATABASE_URL for tests that need direct DB access (e.g., OTP retrieval)
process.env.DATABASE_URL = databaseUrl;

export default defineConfig({
  globalSetup: "./tests/e2e/playwright/global-setup.ts",
  globalTeardown: "./tests/e2e/playwright/global-teardown.ts",
  testDir: "./tests/e2e/playwright",
  testMatch: "**/*.test.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 2,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    navigationTimeout: 60_000,
    extraHTTPHeaders: {
      // Bypass auth rate limiting for test requests
      ...(process.env.TEST_API_KEY && {
        "X-Test-API-Key": process.env.TEST_API_KEY,
      }),
      // Bypass the mandatory-MFA enrollment gate (proxy.ts) for e2e traffic
      ...(process.env.LOAD_TEST_BYPASS_TOKEN && {
        "x-load-test-mfa-bypass": process.env.LOAD_TEST_BYPASS_TOKEN,
      }),
      // Cloudflare Access headers for deployed PR environments
      ...(isDeployedEnv &&
        process.env.CF_ACCESS_CLIENT_ID &&
        process.env.CF_ACCESS_CLIENT_SECRET && {
          "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
        }),
    },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/playwright/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "chromium-inviter",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/playwright/.auth/inviter.json",
      },
      dependencies: ["setup"],
      testMatch: [],
    },
    {
      name: "chromium-bystander",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/playwright/.auth/bystander.json",
      },
      dependencies: ["setup"],
      testMatch: [],
    },
  ],
  // In CI, the workflow builds and starts the app before running tests.
  // In deployed environments, tests run against the deployed URL.
  // Locally, start a dev server if one isn't already running.
  webServer:
    isDeployedEnv || process.env.CI
      ? undefined
      : {
          command: isProdMode ? "pnpm build && pnpm start" : "pnpm dev",
          url: "http://localhost:3000",
          reuseExistingServer: !isProdMode,
          timeout: isProdMode ? 240_000 : 120_000,
        },
});
