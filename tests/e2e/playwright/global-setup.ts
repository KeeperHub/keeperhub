import dotenv from "dotenv";
import { expand } from "dotenv-expand";
import { cleanupTestUsers } from "./utils/cleanup";
import { isRemoteMode } from "./utils/env";
import {
  cleanupPersistentTestUsers,
  seedAnalyticsData,
  seedPersistentTestUsers,
} from "./utils/seed";

const DEFAULT_DB_URL =
  "postgresql://postgres:postgres@localhost:5433/keeperhub";

function preflightChecks(): void {
  const errors: string[] = [];

  if (process.env.BASE_URL) {
    // Remote mode: running against a deployed environment
    if (!process.env.TEST_API_KEY) {
      errors.push(
        "BASE_URL is set but TEST_API_KEY is missing. Remote mode requires both."
      );
    }
  } else {
    // Ephemeral mode: running against local/CI with direct DB access
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl || dbUrl.includes("${")) {
      console.log(
        `DATABASE_URL not set or unexpanded, defaulting to ${DEFAULT_DB_URL}`
      );
      process.env.DATABASE_URL = DEFAULT_DB_URL;
    }
  }

  if (errors.length > 0) {
    const message = [
      "Preflight check failed:",
      ...errors.map((e) => `  - ${e}`),
    ].join("\n");
    throw new Error(message);
  }
}

async function globalSetup(): Promise<void> {
  expand(dotenv.config());
  preflightChecks();

  if (isRemoteMode()) {
    console.log(`Remote mode: testing against ${process.env.BASE_URL}`);
    if (process.env.DATABASE_URL) {
      console.log("DATABASE_URL available, seeding persistent test users...");
      await cleanupTestUsers();
      await cleanupPersistentTestUsers();
      await seedPersistentTestUsers();
      await seedAnalyticsData();
    }
    return;
  }

  // Ephemeral mode: seed local database
  await cleanupTestUsers();
  await cleanupPersistentTestUsers();
  await seedPersistentTestUsers();
  await seedAnalyticsData();
}

export default globalSetup;
