import { createHash, createHmac } from "node:crypto";
import type { DBAdapter, Where } from "better-auth";

// KEEP-239: better-auth 1.5.6 stores `sessions.token` plaintext, which gives
// any attacker who reads the DB live bearer tokens. Until upstream supports
// `session: { hashToken: true }` we wrap the adapter so the column holds
// sha256(token) while the token returned from `create` (and therefore the
// cookie / bearer payload) remains the raw value the client must present.
//
// Coupled to two undocumented call shapes in better-auth:
//   - createSession passes `data.token` as the raw token on `create`.
//   - findSession / findSessions / updateSession / deleteSession all locate
//     rows via `where: [{ field: "token", value }]` (eq) or `operator: "in"`.
// If either changes upstream, the unit tests in
// tests/unit/auth-session-token-hash.test.ts will fail before the bug ships.
//
// Round-trip contract: for any read/update where the caller supplied a raw
// token in the where clause (or in the update payload), the returned row's
// `.token` is rewritten back to that raw value. better-auth re-uses
// `session.token` for subsequent ops (e.g. setActiveOrganization loads the
// session, then calls `updateSession(session.token, ...)`); without this
// rewrite the second hop hashes an already-hashed value and silently misses,
// returning null and breaking the calling endpoint.
//
// Rows returned without a token-keyed lookup (e.g. `findMany` by userId for
// session listing) keep the stored hash on `.token`. Callers must not feed
// those tokens back into a token-keyed query.
//
// IMPORTANT: this wrapper is bypassed when `betterAuth({ secondaryStorage })`
// is configured. better-auth's createSession writes directly to the cache via
// `secondaryStorage.set(data.token, ...)` without calling the DB adapter, so
// plaintext tokens would land in the cache. If the project ever enables
// secondaryStorage, this protection must be re-implemented at that layer too.

const SESSION_MODEL = "session";
const TOKEN_FIELD = "token";

type CreateArgs = Parameters<DBAdapter["create"]>[0];
type FindOneArgs = Parameters<DBAdapter["findOne"]>[0];
type FindManyArgs = Parameters<DBAdapter["findMany"]>[0];
type CountArgs = Parameters<DBAdapter["count"]>[0];
type UpdateArgs = Parameters<DBAdapter["update"]>[0];
type UpdateManyArgs = Parameters<DBAdapter["updateMany"]>[0];
type DeleteArgs = Parameters<DBAdapter["delete"]>[0];
type DeleteManyArgs = Parameters<DBAdapter["deleteMany"]>[0];

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Better Auth signs the `better-auth.session_token` cookie value via
 * hono's setSignedCookie: HMAC-SHA256 of the raw token under the
 * BETTER_AUTH_SECRET, base64-encoded, joined with a literal "." after
 * the raw token. Reading the cookie (auth.api.getSession) verifies
 * the signature and rejects the value when it does not match.
 *
 * Routes that mint a session manually (oauth-mfa-finalize,
 * totp/enroll on the pending-signup path) must produce a cookie that
 * passes this signature check, otherwise the freshly-issued cookie
 * appears valid client-side but is rejected on the very next
 * request and the user ends up anonymous despite the row existing
 * in the sessions table.
 */
export function signSessionCookieValue(
  rawToken: string,
  secret: string
): string {
  const signature = createHmac("sha256", secret)
    .update(rawToken)
    .digest("base64");
  return `${rawToken}.${signature}`;
}

function hashTokenWhere(where: Where[] | undefined): Where[] | undefined {
  if (!where) {
    return where;
  }
  return where.map((clause) => {
    if (clause.field !== TOKEN_FIELD) {
      return clause;
    }
    const op = clause.operator ?? "eq";
    if (op === "in" || op === "not_in") {
      if (!Array.isArray(clause.value)) {
        throw new Error(
          `Session token where with operator "${op}" must have an array value`
        );
      }
      if (!clause.value.every((v) => typeof v === "string")) {
        throw new Error(
          `Session token where with operator "${op}" must contain only string values`
        );
      }
      return { ...clause, value: clause.value.map(hashSessionToken) };
    }
    if (op !== "eq" && op !== "ne") {
      // Substring/range operators on a hashed column never match meaningfully.
      // Throw loudly rather than silently returning the wrong rows if a future
      // caller tries to query sessions by partial token.
      throw new Error(
        `Session token where with operator "${op}" is not supported by the session-token-hash wrapper`
      );
    }
    if (typeof clause.value !== "string") {
      throw new Error(
        `Session token where with operator "${op}" must have a string value, got ${typeof clause.value}`
      );
    }
    return { ...clause, value: hashSessionToken(clause.value) };
  });
}

function hashTokenInUpdate(
  update: Record<string, unknown>
): Record<string, unknown> {
  if (typeof update[TOKEN_FIELD] !== "string") {
    return update;
  }
  return {
    ...update,
    [TOKEN_FIELD]: hashSessionToken(update[TOKEN_FIELD] as string),
  };
}

// Build a hash -> raw map from the raw values the caller put on the wire.
// Only positive matches contribute (eq, in): a row returned from the inner
// adapter is guaranteed to have one of those raw tokens behind its hashed
// column value. ne / not_in tell us nothing about which raw tokens the
// returned rows correspond to, so we deliberately skip them.
function buildTokenRoundTripMap(
  where: Where[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  if (!where) {
    return map;
  }
  for (const clause of where) {
    if (clause.field !== TOKEN_FIELD) {
      continue;
    }
    const op = clause.operator ?? "eq";
    if (op === "eq" && typeof clause.value === "string") {
      map.set(hashSessionToken(clause.value), clause.value);
    } else if (op === "in" && Array.isArray(clause.value)) {
      for (const v of clause.value) {
        if (typeof v === "string") {
          map.set(hashSessionToken(v), v);
        }
      }
    }
  }
  return map;
}

function restoreSessionTokenInRow<T>(row: T, remap: Map<string, string>): T {
  if (!row || remap.size === 0) {
    return row;
  }
  const r = row as unknown as Record<string, unknown>;
  const stored = r[TOKEN_FIELD];
  if (typeof stored !== "string") {
    return row;
  }
  const raw = remap.get(stored);
  if (!raw) {
    return row;
  }
  return { ...r, [TOKEN_FIELD]: raw } as unknown as T;
}

type AdapterFactory = (...args: never[]) => DBAdapter;

export function wrapWithSessionTokenHash<F extends AdapterFactory>(
  factory: F
): F {
  const wrapped = ((...args: Parameters<F>) => {
    const inner = factory(...args);
    return wrapAdapter(inner);
  }) as F;
  return wrapped;
}

function wrapAdapter(inner: DBAdapter): DBAdapter {
  return {
    ...inner,
    // The cast on `create` is intentional and worth preserving. DBAdapter.create
    // is `<T, R = T>(data: { model; data: Omit<T, "id">; ... }) => Promise<R>`,
    // so writing the body as a generic function loses the `T` binding when we
    // spread `data` into a fresh object: TS widens to `Record<string, any>`
    // which then doesn't satisfy `Omit<T, "id">` on the recursive inner.create
    // call. Casting the implementation to `DBAdapter["create"]` keeps the
    // public type intact at the cost of unchecked types inside the function;
    // we get the type-checking back at the call sites where it matters.
    create: ((data: CreateArgs) => {
      const incoming = data.data as Record<string, unknown>;
      if (
        data.model !== SESSION_MODEL ||
        typeof incoming[TOKEN_FIELD] !== "string"
      ) {
        return inner.create(data);
      }
      const rawToken = incoming[TOKEN_FIELD] as string;
      const hashed = {
        ...data,
        data: { ...incoming, [TOKEN_FIELD]: hashSessionToken(rawToken) },
      } as CreateArgs;
      return inner.create(hashed).then((stored) => ({
        ...(stored as Record<string, unknown>),
        [TOKEN_FIELD]: rawToken,
      }));
    }) as DBAdapter["create"],
    // Each method below is async so that a synchronous throw from
    // hashTokenWhere / hashTokenInUpdate becomes a rejected promise rather
    // than crashing the caller's call site. better-auth always awaits, so a
    // rejected promise surfaces as a normal error.
    findOne: async <T>(data: FindOneArgs): Promise<T | null> => {
      if (data.model !== SESSION_MODEL) {
        return await inner.findOne<T>(data);
      }
      const remap = buildTokenRoundTripMap(data.where);
      const result = await inner.findOne<T>({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
      });
      return result ? restoreSessionTokenInRow(result, remap) : result;
    },
    findMany: async <T>(data: FindManyArgs): Promise<T[]> => {
      if (data.model !== SESSION_MODEL) {
        return await inner.findMany<T>(data);
      }
      const remap = buildTokenRoundTripMap(data.where);
      const results = await inner.findMany<T>({
        ...data,
        where: hashTokenWhere(data.where),
      });
      if (remap.size === 0) {
        return results;
      }
      return results.map((row) => restoreSessionTokenInRow(row, remap));
    },
    count: async (data: CountArgs): Promise<number> => {
      if (data.model !== SESSION_MODEL) {
        return await inner.count(data);
      }
      return await inner.count({ ...data, where: hashTokenWhere(data.where) });
    },
    update: async <T>(data: UpdateArgs): Promise<T | null> => {
      if (data.model !== SESSION_MODEL) {
        return await inner.update<T>(data);
      }
      const remap = buildTokenRoundTripMap(data.where);
      // If the caller is rotating the token, the returned row's stored value
      // will be hash(newRaw); add that to the map so the caller can keep
      // signing with the raw token they just wrote.
      const updateToken = data.update[TOKEN_FIELD];
      if (typeof updateToken === "string") {
        remap.set(hashSessionToken(updateToken), updateToken);
      }
      const result = await inner.update<T>({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
        update: hashTokenInUpdate(data.update),
      });
      return result ? restoreSessionTokenInRow(result, remap) : result;
    },
    updateMany: async (data: UpdateManyArgs): Promise<number> => {
      if (data.model !== SESSION_MODEL) {
        return await inner.updateMany(data);
      }
      return await inner.updateMany({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
        update: hashTokenInUpdate(data.update),
      });
    },
    delete: async <T>(data: DeleteArgs): Promise<void> => {
      if (data.model !== SESSION_MODEL) {
        await inner.delete<T>(data);
        return;
      }
      await inner.delete<T>({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
      });
    },
    deleteMany: async (data: DeleteManyArgs): Promise<number> => {
      if (data.model !== SESSION_MODEL) {
        return await inner.deleteMany(data);
      }
      return await inner.deleteMany({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
      });
    },
  };
}
