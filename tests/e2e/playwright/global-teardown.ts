import dotenv from "dotenv";
import { expand } from "dotenv-expand";
import { cleanupTestUsers } from "./utils/cleanup";
import { isRemoteMode } from "./utils/env";
import { cleanupPersistentTestUsers } from "./utils/seed";

const DEFAULT_DB_URL =
  "postgresql://postgres:postgres@localhost:5433/keeperhub";

async function globalTeardown(): Promise<void> {
  expand(dotenv.config());

  if (isRemoteMode()) {
    return;
  }

  const envDbUrl = process.env.DATABASE_URL;
  if (!envDbUrl || envDbUrl.includes("${")) {
    process.env.DATABASE_URL = DEFAULT_DB_URL;
  }

  await cleanupTestUsers();
  await cleanupPersistentTestUsers();
}

export default globalTeardown;
