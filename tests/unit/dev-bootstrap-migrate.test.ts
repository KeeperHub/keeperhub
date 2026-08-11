import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const postgresMock = vi.hoisted(() => vi.fn());
const endMock = vi.hoisted(() => vi.fn());
const migrateMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("postgres", () => ({
  default: postgresMock,
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (client: unknown) => client,
}));

vi.mock("drizzle-orm/postgres-js/migrator", () => ({
  migrate: migrateMock,
}));

import {
  assertMigrateSucceeded,
  BACKFILL_COMMAND,
  MIGRATE_LABEL,
  runMigrateWithRecovery,
} from "@/scripts/lib/migration-drift";

const BACKFILL_SCRIPT_SUFFIX = "backfill-drizzle-migrations.ts";
const DB_URL = "postgresql://postgres:postgres@localhost:5433/keeperhub";

function duplicateTableError(): Error {
  const pgError = Object.assign(new Error('relation "users" already exists'), {
    code: "42P07",
    name: "PostgresError",
  });
  return Object.assign(new Error('Failed query: CREATE TABLE "users"'), {
    cause: pgError,
  });
}

function mockPostgresClient(options: {
  usersExists: boolean;
  journalCount: number;
}): void {
  endMock.mockResolvedValue(undefined);
  const client = async (
    strings: TemplateStringsArray
  ): Promise<Array<{ exists?: boolean; c?: number }>> => {
    const query = strings.join("");
    if (query.includes("information_schema.tables")) {
      return [{ exists: options.usersExists }];
    }
    if (query.includes("COUNT(*)") && query.includes("__drizzle_migrations")) {
      return [{ c: options.journalCount }];
    }
    return [];
  };
  postgresMock.mockReturnValue(Object.assign(client, { end: endMock }));
}

/** Queues migrate() outcomes in call order: `null` succeeds, an error rejects. */
function mockMigrateSequence(outcomes: Array<Error | null>): void {
  let call = 0;
  migrateMock.mockImplementation(() => {
    // Bounds check, not `??`: a queued `null` means success and is nullish.
    const outcome =
      call < outcomes.length
        ? outcomes[call]
        : new Error("unexpected migrate call");
    call += 1;
    return outcome ? Promise.reject(outcome) : Promise.resolve();
  });
}

function mockBackfill(status: number, output = ""): void {
  spawnSyncMock.mockReturnValue({
    status,
    stdout: output,
    stderr: "",
    error: undefined,
  });
}

describe("runMigrateWithRecovery", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    postgresMock.mockReset();
    endMock.mockReset();
    migrateMock.mockReset();
  });

  it("returns ok when the first migration succeeds, without probing", async () => {
    mockMigrateSequence([null]);

    const result = await runMigrateWithRecovery(DB_URL, process.env, () => {
      /* silent */
    });

    expect(result.ok).toBe(true);
    expect(migrateMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    // One client for the migration itself, none for a drift probe.
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });

  it("backfills the whole journal and retries on duplicate-object drift", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 11 });
    mockMigrateSequence([duplicateTableError(), null]);
    mockBackfill(0, "Inserted 128, skipped 11");

    const logs: string[] = [];
    const result = await runMigrateWithRecovery(DB_URL, process.env, (m) =>
      logs.push(m)
    );

    expect(result.ok).toBe(true);
    expect(migrateMock).toHaveBeenCalledTimes(2);
    expect(logs).toContain(
      "dev-bootstrap: migration drift detected (schema ahead of journal)"
    );
    // Exact args: any reintroduced bound flag fails here.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "pnpm",
      ["tsx", expect.stringContaining(BACKFILL_SCRIPT_SUFFIX)],
      expect.objectContaining({ encoding: "utf8" })
    );
  });

  it("does not recover when the failure is not a duplicate object", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 11 });
    mockMigrateSequence([
      Object.assign(new Error("syntax error at end of input"), {
        code: "42601",
      }),
    ]);

    const result = await runMigrateWithRecovery(DB_URL, process.env, () => {
      /* silent */
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("syntax error");
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(migrateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the migration error when the drift probe cannot connect", async () => {
    mockMigrateSequence([duplicateTableError()]);
    let call = 0;
    postgresMock.mockImplementation(() => {
      call += 1;
      // First call is the migration's own client; the second is the probe.
      if (call === 1) {
        return Object.assign(async () => [], { end: endMock });
      }
      throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
    });
    endMock.mockResolvedValue(undefined);

    const result = await runMigrateWithRecovery(DB_URL, process.env, () => {
      /* silent */
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('relation "users" already exists');
    expect(result.output).not.toContain("ECONNREFUSED");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("names the backfill command when the backfill itself fails", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 0 });
    mockMigrateSequence([duplicateTableError()]);
    mockBackfill(3, "backfill blew up");

    const result = await runMigrateWithRecovery(DB_URL, process.env, () => {
      /* silent */
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(`${BACKFILL_COMMAND} exited with status 3`);
    expect(result.output).toContain('relation "users" already exists');
    expect(result.output).toContain("backfill blew up");
    expect(migrateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps both failures when the retry fails for another reason", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 0 });
    mockMigrateSequence([
      duplicateTableError(),
      new Error("connection terminated unexpectedly"),
    ]);
    mockBackfill(0);

    const result = await runMigrateWithRecovery(DB_URL, process.env, () => {
      /* silent */
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('relation "users" already exists');
    expect(result.output).toContain("connection terminated");
    expect(result.reason).toContain("after journal backfill");
  });
});

describe("assertMigrateSucceeded", () => {
  it("is a no-op when the migration succeeded", () => {
    expect(() =>
      assertMigrateSucceeded({ ok: true, output: "" })
    ).not.toThrow();
  });

  it("writes output to stderr and throws with the reason", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    expect(() =>
      assertMigrateSucceeded({
        ok: false,
        output: "migrate blew up",
        reason: `${BACKFILL_COMMAND} exited with status 3`,
      })
    ).toThrowError(`${BACKFILL_COMMAND} exited with status 3`);

    expect(writeSpy).toHaveBeenCalledWith("migrate blew up");
    expect(writeSpy).toHaveBeenCalledWith("\n");
    writeSpy.mockRestore();
  });

  it("does not add a newline when the output already ends with one", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    expect(() =>
      assertMigrateSucceeded({ ok: false, output: "already newline\n" })
    ).toThrowError(`${MIGRATE_LABEL} failed`);

    expect(writeSpy).toHaveBeenCalledWith("already newline\n");
    expect(writeSpy).not.toHaveBeenCalledWith("\n");
    writeSpy.mockRestore();
  });
});
