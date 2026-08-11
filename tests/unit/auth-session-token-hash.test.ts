import { createHash } from "node:crypto";
import type { DBAdapter, Where } from "better-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashSessionToken,
  wrapWithSessionTokenHash,
} from "@/lib/auth-session-token-hash";

const RAW = "raw-session-token-abcdef0123456789";
const HASH = createHash("sha256").update(RAW).digest("hex");
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UNSUPPORTED_OP_PATTERN = /operator "contains" is not supported/;
const NON_STRING_VALUE_PATTERN = /must have a string value/;
const NON_ARRAY_VALUE_PATTERN = /must have an array value/;

type Mock = ReturnType<typeof vi.fn>;

type AdapterMocks = {
  create: Mock;
  findOne: Mock;
  findMany: Mock;
  count: Mock;
  update: Mock;
  updateMany: Mock;
  delete: Mock;
  deleteMany: Mock;
};

function buildInner(): { inner: DBAdapter; mocks: AdapterMocks } {
  const mocks: AdapterMocks = {
    create: vi.fn(async (data) => data.data),
    findOne: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(async () => null),
    updateMany: vi.fn(async () => 0),
    delete: vi.fn(async () => undefined),
    deleteMany: vi.fn(async () => 0),
  };
  const inner: DBAdapter = {
    id: "mock",
    create: mocks.create,
    findOne: mocks.findOne,
    findMany: mocks.findMany,
    count: mocks.count,
    update: mocks.update,
    updateMany: mocks.updateMany,
    delete: mocks.delete,
    deleteMany: mocks.deleteMany,
    createSchema: undefined,
    options: undefined,
  } as unknown as DBAdapter;
  return { inner, mocks };
}

function build(): { wrapped: DBAdapter; mocks: AdapterMocks } {
  const { inner, mocks } = buildInner();
  const factory = vi.fn(() => inner) as unknown as () => DBAdapter;
  const wrappedFactory = wrapWithSessionTokenHash(factory);
  const wrapped = wrappedFactory();
  return { wrapped, mocks };
}

describe("hashSessionToken", () => {
  it("returns hex-encoded sha256", () => {
    expect(hashSessionToken(RAW)).toBe(HASH);
    expect(hashSessionToken(RAW)).toMatch(SHA256_HEX_PATTERN);
  });
});

describe("wrapWithSessionTokenHash", () => {
  let wrapped: DBAdapter;
  let mocks: AdapterMocks;

  beforeEach(() => {
    ({ wrapped, mocks } = build());
  });

  describe("create", () => {
    it("hashes the token before storage and restores raw token in result", async () => {
      mocks.create.mockImplementationOnce(
        async (data: { data: Record<string, unknown> }) => ({
          id: "sess-1",
          ...data.data,
        })
      );

      const result = await wrapped.create({
        model: "session",
        data: { token: RAW, userId: "u-1", expiresAt: new Date() },
      });

      expect(mocks.create).toHaveBeenCalledOnce();
      const stored = mocks.create.mock.calls[0][0].data;
      expect(stored.token).toBe(HASH);
      expect((result as { token: string }).token).toBe(RAW);
    });

    it("does not touch creates for other models", async () => {
      await wrapped.create({
        model: "user",
        data: { token: RAW, email: "x@y.z" },
      });
      expect(mocks.create.mock.calls[0][0].data.token).toBe(RAW);
    });

    it("passes through session creates that have no token field", async () => {
      await wrapped.create({
        model: "session",
        data: { userId: "u-1", expiresAt: new Date() },
      });
      const stored = mocks.create.mock.calls[0][0].data;
      expect(stored.token).toBeUndefined();
    });
  });

  describe("findOne", () => {
    it("hashes session token in eq where clause", async () => {
      await wrapped.findOne({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("hashes session token with explicit operator: eq", async () => {
      await wrapped.findOne({
        model: "session",
        where: [{ field: "token", value: RAW, operator: "eq" }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("does not hash where clauses on non-token fields", async () => {
      await wrapped.findOne({
        model: "session",
        where: [{ field: "id", value: RAW }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(RAW);
    });

    it("ignores findOne for non-session models", async () => {
      await wrapped.findOne({
        model: "user",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(RAW);
    });

    it("throws on substring operators against the token field", async () => {
      await expect(
        wrapped.findOne({
          model: "session",
          where: [{ field: "token", value: RAW, operator: "contains" }],
        })
      ).rejects.toThrow(UNSUPPORTED_OP_PATTERN);
      expect(mocks.findOne).not.toHaveBeenCalled();
    });

    it("throws on non-string values for token eq lookups", async () => {
      await expect(
        wrapped.findOne({
          model: "session",
          where: [{ field: "token", value: 12_345 }],
        })
      ).rejects.toThrow(NON_STRING_VALUE_PATTERN);
      expect(mocks.findOne).not.toHaveBeenCalled();
    });

    it("rewrites the returned row's token back to the raw value", async () => {
      mocks.findOne.mockImplementationOnce(async () => ({
        id: "sess-1",
        token: HASH,
        userId: "u-1",
      }));
      const found = await wrapped.findOne<{ id: string; token: string }>({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      expect(found?.token).toBe(RAW);
    });

    it("leaves the row untouched when the returned hash is unrelated", async () => {
      // Defensive: if the inner adapter returns a row whose hash doesn't
      // match what we looked up (shouldn't happen with eq), don't pretend it
      // was the caller's raw token.
      const otherHash = hashSessionToken("different-token");
      mocks.findOne.mockImplementationOnce(async () => ({
        id: "sess-other",
        token: otherHash,
      }));
      const found = await wrapped.findOne<{ id: string; token: string }>({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      expect(found?.token).toBe(otherHash);
    });

    it("returns null untouched when the inner adapter finds nothing", async () => {
      mocks.findOne.mockImplementationOnce(async () => null);
      const found = await wrapped.findOne({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      expect(found).toBeNull();
    });

    it("does not rewrite the token when the where lookup is by id", async () => {
      mocks.findOne.mockImplementationOnce(async () => ({
        id: "sess-1",
        token: HASH,
      }));
      const found = await wrapped.findOne<{ token: string }>({
        model: "session",
        where: [{ field: "id", value: "sess-1" }],
      });
      // No token on the wire, no raw value to map back to.
      expect(found?.token).toBe(HASH);
    });
  });

  describe("findMany", () => {
    it("hashes each value in operator: in arrays", async () => {
      const tokens = [RAW, "another-token"];
      const expected = tokens.map(hashSessionToken);
      await wrapped.findMany({
        model: "session",
        where: [{ field: "token", value: tokens, operator: "in" }],
      });
      const where = mocks.findMany.mock.calls[0][0].where as Where[];
      expect(where[0].value).toEqual(expected);
    });

    it("throws when operator: in receives a non-array value", async () => {
      await expect(
        wrapped.findMany({
          model: "session",
          where: [{ field: "token", value: RAW, operator: "in" }],
        })
      ).rejects.toThrow(NON_ARRAY_VALUE_PATTERN);
    });

    it("rewrites each returned row's token back to its raw value", async () => {
      const otherRaw = "another-raw-token";
      mocks.findMany.mockImplementationOnce(async () => [
        { id: "sess-a", token: HASH },
        { id: "sess-b", token: hashSessionToken(otherRaw) },
      ]);
      const rows = await wrapped.findMany<{ id: string; token: string }>({
        model: "session",
        where: [{ field: "token", value: [RAW, otherRaw], operator: "in" }],
      });
      expect(rows.map((r) => r.token).sort()).toEqual([RAW, otherRaw].sort());
    });

    it("leaves rows untouched when the where has no token clause", async () => {
      mocks.findMany.mockImplementationOnce(async () => [
        { id: "sess-a", token: HASH },
      ]);
      const rows = await wrapped.findMany<{ token: string }>({
        model: "session",
        where: [{ field: "userId", value: "u-1" }],
      });
      // Listing by userId can't recover raw tokens; the stored hash leaks
      // through. Caller must not feed these back into a token-keyed query.
      expect(rows[0].token).toBe(HASH);
    });
  });

  describe("count", () => {
    it("hashes session token in eq where clause", async () => {
      await wrapped.count({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.count.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("passes through count for non-session models", async () => {
      await wrapped.count({
        model: "user",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.count.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(RAW);
    });
  });

  describe("update / updateMany", () => {
    it("hashes where token and any new token in the update payload", async () => {
      const newRaw = "rotated-token";
      await wrapped.update({
        model: "session",
        where: [{ field: "token", value: RAW }],
        update: { token: newRaw, expiresAt: new Date() },
      });
      const call = mocks.update.mock.calls[0][0];
      expect((call.where as Where[])[0].value).toBe(HASH);
      expect(call.update.token).toBe(hashSessionToken(newRaw));
    });

    it("rewrites the returned row's token back to the raw value", async () => {
      // Reproduces the setActiveOrganization regression: better-auth loads a
      // session, then calls updateSession(session.token, ...). Our wrapper
      // must hand back the raw token on the loaded row so the second hop
      // hashes once, not twice.
      mocks.update.mockImplementationOnce(async () => ({
        id: "sess-1",
        token: HASH,
        activeOrganizationId: "org-1",
      }));
      const result = await wrapped.update<{
        id: string;
        token: string;
      }>({
        model: "session",
        where: [{ field: "token", value: RAW }],
        update: { activeOrganizationId: "org-1" },
      });
      expect(result?.token).toBe(RAW);
    });

    it("returns the rotated raw token when the update payload sets a new token", async () => {
      const newRaw = "rotated-token";
      mocks.update.mockImplementationOnce(async () => ({
        id: "sess-1",
        token: hashSessionToken(newRaw),
      }));
      const result = await wrapped.update<{ token: string }>({
        model: "session",
        // Lookup by id — only the new token in the update payload is
        // available for the round-trip map.
        where: [{ field: "id", value: "sess-1" }],
        update: { token: newRaw },
      });
      expect(result?.token).toBe(newRaw);
    });

    it("returns null untouched when the inner adapter updates nothing", async () => {
      mocks.update.mockImplementationOnce(async () => null);
      const result = await wrapped.update({
        model: "session",
        where: [{ field: "token", value: RAW }],
        update: { activeOrganizationId: "org-1" },
      });
      expect(result).toBeNull();
    });

    it("updateMany hashes where clause", async () => {
      await wrapped.updateMany({
        model: "session",
        where: [{ field: "token", value: RAW }],
        update: { expiresAt: new Date() },
      });
      const where = mocks.updateMany.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });
  });

  describe("delete / deleteMany", () => {
    it("hashes session token where clauses", async () => {
      await wrapped.delete({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.delete.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("deleteMany hashes session token where clauses", async () => {
      await wrapped.deleteMany({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.deleteMany.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });
  });
});
