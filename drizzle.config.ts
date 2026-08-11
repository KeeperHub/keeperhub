import { config } from "dotenv";
import type { Config } from "drizzle-kit";
import { getDatabaseUrl } from "./lib/db/connection-utils";

config();

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: getDatabaseUrl(),
  },
  // Only manage the `public` schema. Workflow DevKit owns its own
  // `workflow` schema (tables like workflow.workflow_waits and the
  // wait_status enum it references) and creates them at runtime; if we
  // let drizzle introspect everything, `pnpm db:push` tries to drop our
  // unreferenced enum and Postgres blocks with "cannot drop type
  // wait_status because other objects depend on it".
  schemaFilter: ["public"],
} satisfies Config;
