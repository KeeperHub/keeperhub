import { describe, expect, it } from "vitest";
import {
  describeError,
  getExpectedJournalCount,
  isDuplicateObjectError,
  isMissingRelationError,
  type PostgresClient,
  queryJournalDriftState,
  shouldRecoverAfterMigrateFailure,
} from "@/scripts/lib/migration-drift";

/**
 * Shape captured from drizzle-orm's migrator failing against a database whose
 * schema was applied by `db:push`: the outer error carries the statement, the
 * postgres.js error underneath carries the SQLSTATE.
 */
function duplicateTableError(): Error {
  const pgError = Object.assign(new Error('relation "users" already exists'), {
    code: "42P07",
    name: "PostgresError",
  });
  return Object.assign(
    new Error('Failed query: CREATE TABLE "users" (\n\t"id" text\n)'),
    { cause: pgError }
  );
}

function createMockClient(options: {
  usersExists: boolean;
  journalCount?: number;
  journalError?: unknown;
}): PostgresClient {
  const end = async (): Promise<void> => undefined;
  const client = async (
    strings: TemplateStringsArray
  ): Promise<Array<{ exists?: boolean; c?: number }>> => {
    const query = strings.join("");
    if (query.includes("information_schema.tables")) {
      return [{ exists: options.usersExists }];
    }
    if (query.includes("COUNT(*)") && query.includes("__drizzle_migrations")) {
      if (options.journalError !== undefined) {
        throw options.journalError;
      }
      return [{ c: options.journalCount ?? 0 }];
    }
    return [];
  };
  return Object.assign(client, { end }) as unknown as PostgresClient;
}

describe("isMissingRelationError", () => {
  it("matches the undefined_table SQLSTATE", () => {
    expect(isMissingRelationError({ code: "42P01" })).toBe(true);
  });

  it("matches a relation-does-not-exist message without a code", () => {
    expect(
      isMissingRelationError({
        message: 'relation "drizzle.__drizzle_migrations" does not exist',
      })
    ).toBe(true);
  });

  it("does not match permission errors", () => {
    expect(
      isMissingRelationError({
        code: "42501",
        message: "permission denied for table __drizzle_migrations",
      })
    ).toBe(false);
  });

  it("terminates on a self-referential cause chain", () => {
    const looping: { code: string; cause?: unknown } = { code: "42501" };
    looping.cause = looping;
    expect(isMissingRelationError(looping)).toBe(false);
  });
});

describe("isDuplicateObjectError", () => {
  it("matches duplicate_table nested under the failing statement", () => {
    expect(isDuplicateObjectError(duplicateTableError())).toBe(true);
  });

  it.each([
    ["42P07", "duplicate_table"],
    ["42701", "duplicate_column"],
    ["42710", "duplicate_object"],
    ["42P06", "duplicate_schema"],
  ])("matches %s (%s)", (code) => {
    expect(isDuplicateObjectError({ code })).toBe(true);
  });

  it("does not match a unique violation, which is data and not schema drift", () => {
    expect(
      isDuplicateObjectError({
        code: "23505",
        message: "duplicate key value violates unique constraint",
      })
    ).toBe(false);
  });

  it("does not match a syntax error", () => {
    expect(
      isDuplicateObjectError({ code: "42601", message: "syntax error at end" })
    ).toBe(false);
  });

  it("does not match a connection failure", () => {
    expect(
      isDuplicateObjectError(new Error("connect ECONNREFUSED 127.0.0.1:5433"))
    ).toBe(false);
  });

  it("falls back to the message only when no code is present", () => {
    expect(
      isDuplicateObjectError({ message: 'relation "users" already exists' })
    ).toBe(true);
  });
});

describe("describeError", () => {
  it("renders the statement, the SQLSTATE and the cause chain", () => {
    const text = describeError(duplicateTableError());
    expect(text).toContain("Failed query:");
    expect(text).toContain("caused by:");
    expect(text).toContain("[42P07]");
    expect(text).toContain('relation "users" already exists');
  });
});

describe("queryJournalDriftState", () => {
  it("treats a missing journal table as count 0", async () => {
    const state = await queryJournalDriftState(
      createMockClient({
        usersExists: true,
        journalError: {
          code: "42P01",
          message: 'relation "drizzle.__drizzle_migrations" does not exist',
        },
      })
    );

    expect(state.journalCount).toBe(0);
    expect(state.usersExists).toBe(true);
    expect(state.expectedCount).toBe(getExpectedJournalCount());
  });

  it("rethrows permission errors instead of reporting an empty journal", async () => {
    await expect(
      queryJournalDriftState(
        createMockClient({
          usersExists: true,
          journalError: {
            code: "42501",
            message: "permission denied for table __drizzle_migrations",
          },
        })
      )
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("shouldRecoverAfterMigrateFailure", () => {
  it("recovers when the schema is ahead of an empty journal", async () => {
    const client = createMockClient({ usersExists: true, journalCount: 0 });
    expect(
      await shouldRecoverAfterMigrateFailure(client, duplicateTableError())
    ).toBe(true);
  });

  it("recovers when the journal is partially populated", async () => {
    // The case a journal-derived --through bound turned into a no-op: migrated
    // partway, then db:push pulled the schema up to HEAD.
    const client = createMockClient({
      usersExists: true,
      journalCount: getExpectedJournalCount() - 1,
    });
    expect(
      await shouldRecoverAfterMigrateFailure(client, duplicateTableError())
    ).toBe(true);
  });

  it("does not recover when the journal is fully populated", async () => {
    const client = createMockClient({
      usersExists: true,
      journalCount: getExpectedJournalCount(),
    });
    expect(
      await shouldRecoverAfterMigrateFailure(client, duplicateTableError())
    ).toBe(false);
  });

  it("does not recover on a fresh database with no public schema", async () => {
    const client = createMockClient({ usersExists: false, journalCount: 0 });
    expect(
      await shouldRecoverAfterMigrateFailure(client, duplicateTableError())
    ).toBe(false);
  });

  it("does not recover for a failure that is not a duplicate object", async () => {
    const client = createMockClient({ usersExists: true, journalCount: 0 });
    expect(
      await shouldRecoverAfterMigrateFailure(
        client,
        Object.assign(new Error("syntax error at end of input"), {
          code: "42601",
        })
      )
    ).toBe(false);
  });
});

describe("getExpectedJournalCount", () => {
  it("reads a non-zero entry count from the journal file", () => {
    expect(getExpectedJournalCount()).toBeGreaterThan(0);
  });
});
