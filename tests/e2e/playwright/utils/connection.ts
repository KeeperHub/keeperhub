import postgres from "postgres";

export function getDbConnection(): ReturnType<typeof postgres> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return postgres(databaseUrl, { max: 1 });
}
