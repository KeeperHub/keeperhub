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
    // Cloudflare Access headers for deployed PR environments
    ...(isDeployedEnv &&
      process.env.CF_ACCESS_CLIENT_ID &&
      process.env.CF_ACCESS_CLIENT_SECRET && {
        extraHTTPHeaders: {
          "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
        },
      }),
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
  // Only start local dev server when not running against deployed environment
  webServer: isDeployedEnv
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
