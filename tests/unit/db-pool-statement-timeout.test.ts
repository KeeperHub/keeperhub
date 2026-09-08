/**
 * The app pool carries a per-statement timeout (KEEP-1305).
 *
 * Before this, lib/db's main pool had no bound at all, and on 2026-09-02 about
 * 40 analytics queries each ran for more than an hour on prod. The CronJobs are
 * signed HTTP calls into the same pods, so they share this pool, and the
 * workflow runner reaches it transitively for step logging. That makes the
 * option below the single request-path bound for almost every query the
 * platform issues, which is worth asserting against the real module rather
 * than against a hand-written copy of the config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PoolOptions = {
  max?: number;
  connection?: { statement_timeout?: number };
};

const postgresMock = vi.fn<
  (url: string, options?: PoolOptions) => { end: () => void }
>(() => ({
  end: vi.fn(),
}));

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn(() => ({})) }));

/**
 * Re-import lib/db under the current env and return the pool option objects.
 *
 * tests/setup.ts mocks "@/lib/db" for every suite, so this has to reach past
 * that mock with importActual to get the real module. The "postgres" mock above
 * still applies, so no connection is opened.
 */
async function loadPoolOptions(): Promise<PoolOptions[]> {
  postgresMock.mockClear();
  // lib/db parks its clients on globalThis outside production so HMR does not
  // exhaust connections. vi.resetModules() clears the module registry but not
  // globalThis, so without this the second load reuses the first pool and never
  // calls postgres() again.
  for (const key of ["queryClient", "db", "metricsClient", "metricsDb"]) {
    delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  await vi.importActual("@/lib/db");
  return postgresMock.mock.calls.map((call) => call[1] ?? {});
}

/** The main query pool is the only one built with max: 10. */
function queryPool(options: PoolOptions[]): PoolOptions {
  const pool = options.find((o) => o.max === 10);
  if (!pool) {
    throw new Error(
      `no pool with max:10 among ${JSON.stringify(options)} - lib/db changed shape`
    );
  }
  return pool;
}

describe("app pool statement_timeout", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("bounds the main query pool at 30s by default", async () => {
    process.env.APP_STATEMENT_TIMEOUT_MS = undefined;
    delete process.env.APP_STATEMENT_TIMEOUT_MS;

    const pool = queryPool(await loadPoolOptions());

    expect(pool.connection?.statement_timeout).toBe(30_000);
  });

  it("takes the override from APP_STATEMENT_TIMEOUT_MS", async () => {
    process.env.APP_STATEMENT_TIMEOUT_MS = "45000";

    const pool = queryPool(await loadPoolOptions());

    expect(pool.connection?.statement_timeout).toBe(45_000);
  });

  it.each(["", "not-a-number", "0", "-1"])(
    "falls back to 30s when the override is %j",
    async (value) => {
      process.env.APP_STATEMENT_TIMEOUT_MS = value;

      const pool = queryPool(await loadPoolOptions());

      expect(pool.connection?.statement_timeout).toBe(30_000);
    }
  );

  it("stays below the 120s RDS parameter-group backstop", async () => {
    delete process.env.APP_STATEMENT_TIMEOUT_MS;

    const pool = queryPool(await loadPoolOptions());

    expect(pool.connection?.statement_timeout).toBeLessThan(120_000);
  });
});
