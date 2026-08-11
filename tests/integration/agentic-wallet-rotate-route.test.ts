/**
 * Integration tests for POST /api/agentic-wallet/rotate-hmac (Phase 37 fix #6).
 *
 * The route is HMAC-authenticated. On success it:
 *   1. Looks up the highest existing keyVersion for the sub-org.
 *   2. Inserts a new row at currentVersion + 1 with a freshly minted 64-hex
 *      secret (active, expires_at NULL) via insertHmacSecret.
 *   3. Stamps every still-active (expires_at IS NULL) prior version with
 *      expires_at = now + 24h, EXCLUDING the just-inserted new version so it
 *      stays active. See route comment for single-UPDATE rationale.
 *   4. Returns 200 { newSecret, keyVersion }.
 *
 * Strategy: the HMAC verification path is mocked (verifyHmacRequest) because
 * the route flows we care about are DB-shape: version discovery, grace-window
 * expiry stamping, and first-rotation correctness. A hoisted row-level fake DB
 * mirrors the real drizzle query chains the route uses (select/orderBy/limit
 * for discovery; update/set/where for stamping; insert via insertHmacSecret
 * which itself routes through db.insert).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MockVerify = ReturnType<typeof vi.fn>;

const TEST_SUB_ORG = "subOrg_rotate_test";
const GRACE_MS = 24 * 60 * 60 * 1000;
const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Shape of a row in the in-memory hmac_secrets table. We only track the
 * fields the route / route tests care about.
 */
type RotateRow = {
  subOrgId: string;
  keyVersion: number;
  secretCiphertext: string;
  expiresAt: Date | null;
  createdAt: Date;
};

const { mockVerifyHmacRequest, hmacRows, dbState, lastInsert } = vi.hoisted(
  (): {
    mockVerifyHmacRequest: MockVerify;
    hmacRows: RotateRow[];
    dbState: { throwOnSelect: boolean };
    lastInsert: { subOrgId: string | null; keyVersion: number | null };
  } => ({
    mockVerifyHmacRequest: vi.fn(),
    hmacRows: [],
    dbState: { throwOnSelect: false },
    lastInsert: { subOrgId: null, keyVersion: null },
  })
);

vi.mock("@/lib/agentic-wallet/hmac", () => ({
  verifyHmacRequest: mockVerifyHmacRequest,
}));

// Drizzle column tags. insertHmacSecret + the route both reference
// agenticWalletHmacSecrets.{subOrgId,keyVersion,expiresAt,secretCiphertext}.
vi.mock("@/lib/db/schema", () => ({
  agenticWalletHmacSecrets: {
    __table: "agentic_wallet_hmac_secrets",
    subOrgId: "sub_org_id",
    keyVersion: "key_version",
    secretCiphertext: "secret_ciphertext",
    expiresAt: "expires_at",
    createdAt: "created_at",
  },
}));

// Shared sub-org "filter" state captured by the where() calls. The drizzle
// predicate is opaque to the mock, so we carry the sub-org id through a
// module-level ref that each where() call sets.
const filterSubOrgId: { current: string | null } = { current: null };

/**
 * Row-level in-memory DB. Captures enough of the drizzle query chain to:
 *   - select({ keyVersion }).from(t).where(eq(subOrg)).orderBy(desc).limit(1)
 *   - update(t).set({expiresAt}).where(and(eq(subOrg), isNull(expiresAt), ne(kv)))
 *   - insert(t).values({subOrgId, keyVersion, secretCiphertext, expiresAt})
 *
 * The where() drizzle predicate is unreachable from a mock so we sniff the
 * sub-org id out of the raw args by stringifying — hacky but the sign-route /
 * credit-route tests do the same thing.
 */
vi.mock("@/lib/db", () => {
  type TableMarker = { __table: "agentic_wallet_hmac_secrets" };
  const isHmacTable = (t: unknown): t is TableMarker =>
    typeof t === "object" && t !== null && "__table" in t;

  // Pull TEST_SUB_ORG out of the drizzle predicate by examining the raw
  // Symbol-keyed query args. We bind the filter through a module-level
  // `filterSubOrgId` set at the call site instead — simpler and robust.
  const captureSubOrgFilter = (): string | null => filterSubOrgId.current;

  return {
    db: {
      select: (
        _cols?: unknown
      ): {
        from: (t: unknown) => {
          where: (_w: unknown) => {
            orderBy: (_o: unknown) => {
              limit: (_n: number) => Promise<Array<{ keyVersion: number }>>;
            };
          };
        };
      } => ({
        from: (t: unknown) => ({
          where: (_w: unknown) => ({
            orderBy: (_o: unknown) => ({
              limit: (_n: number): Promise<Array<{ keyVersion: number }>> => {
                if (dbState.throwOnSelect) {
                  throw new Error("boom");
                }
                if (!isHmacTable(t)) {
                  return Promise.resolve([]);
                }
                const subOrg = captureSubOrgFilter();
                const rows = hmacRows
                  .filter((r) =>
                    subOrg === null ? true : r.subOrgId === subOrg
                  )
                  .sort((a, b) => b.keyVersion - a.keyVersion);
                return Promise.resolve(
                  rows.slice(0, 1).map((r) => ({ keyVersion: r.keyVersion }))
                );
              },
            }),
          }),
        }),
      }),
      update: (
        t: unknown
      ): {
        set: (v: { expiresAt: Date | null }) => {
          where: (_w: unknown) => Promise<void>;
        };
      } => ({
        set: (values: { expiresAt: Date | null }) => ({
          where: (_w: unknown): Promise<void> => {
            if (!isHmacTable(t)) {
              return Promise.resolve();
            }
            const subOrg = captureSubOrgFilter();
            // Route's UPDATE predicate is:
            //   subOrgId = auth.subOrgId
            //   AND expiresAt IS NULL
            //   AND keyVersion != newVersion
            // The fake DB cannot introspect drizzle predicates, so the
            // "exclude newVersion" clause is faked by consulting the last
            // INSERT recorded by the insert handler (for this same sub-org).
            const excluded =
              lastInsert.subOrgId === subOrg ? lastInsert.keyVersion : null;
            for (const row of hmacRows) {
              if (subOrg !== null && row.subOrgId !== subOrg) {
                continue;
              }
              if (row.expiresAt !== null) {
                continue;
              }
              if (excluded !== null && row.keyVersion === excluded) {
                continue;
              }
              row.expiresAt = values.expiresAt;
            }
            return Promise.resolve();
          },
        }),
      }),
      insert: (
        t: unknown
      ): {
        values: (v: {
          subOrgId: string;
          keyVersion: number;
          secretCiphertext: string;
          expiresAt: Date | null;
        }) => Promise<void>;
      } => ({
        values: (v: {
          subOrgId: string;
          keyVersion: number;
          secretCiphertext: string;
          expiresAt: Date | null;
        }): Promise<void> => {
          if (!isHmacTable(t)) {
            return Promise.resolve();
          }
          if (
            hmacRows.some(
              (r) => r.subOrgId === v.subOrgId && r.keyVersion === v.keyVersion
            )
          ) {
            return Promise.reject(
              new Error(
                `duplicate key (subOrgId,keyVersion)=(${v.subOrgId},${v.keyVersion})`
              )
            );
          }
          hmacRows.push({
            subOrgId: v.subOrgId,
            keyVersion: v.keyVersion,
            secretCiphertext: v.secretCiphertext,
            expiresAt: v.expiresAt,
            createdAt: new Date(),
          });
          lastInsert.subOrgId = v.subOrgId;
          lastInsert.keyVersion = v.keyVersion;
          return Promise.resolve();
        },
      }),
    },
  };
});

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

beforeAll(() => {
  // hmac-secret-store requires AGENTIC_WALLET_HMAC_KMS_KEY at module eval.
  process.env.AGENTIC_WALLET_HMAC_KMS_KEY = Buffer.alloc(32, 2).toString(
    "base64"
  );
});

// Import after mocks are declared so the route picks up the fakes.
const { POST } = await import("@/app/api/agentic-wallet/rotate-hmac/route");
const { logSystemError } = await import("@/lib/logging");

function makeReq(): Request {
  return new Request("http://localhost:3000/api/agentic-wallet/rotate-hmac", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "",
  });
}

function seedRow(
  subOrgId: string,
  keyVersion: number,
  expiresAt: Date | null = null
): void {
  hmacRows.push({
    subOrgId,
    keyVersion,
    secretCiphertext: `envelope-for-${subOrgId}-v${keyVersion}`,
    expiresAt,
    createdAt: new Date(),
  });
}

beforeEach(() => {
  hmacRows.length = 0;
  dbState.throwOnSelect = false;
  mockVerifyHmacRequest.mockReset();
  filterSubOrgId.current = TEST_SUB_ORG;
  lastInsert.subOrgId = null;
  lastInsert.keyVersion = null;
  vi.mocked(logSystemError).mockReset();
  mockVerifyHmacRequest.mockResolvedValue({
    ok: true,
    subOrgId: TEST_SUB_ORG,
  });
});

describe("POST /api/agentic-wallet/rotate-hmac", () => {
  it("rotates v1 -> v2, stamps v1 grace window, returns new secret", async () => {
    seedRow(TEST_SUB_ORG, 1, null);

    const before = Date.now();
    const res = await POST(makeReq());
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      newSecret: string;
      keyVersion: number;
    };
    expect(body.keyVersion).toBe(2);
    expect(body.newSecret).toMatch(HEX_64_RE);

    // v1 got stamped with expires_at ≈ now+24h.
    const v1 = hmacRows.find(
      (r) => r.subOrgId === TEST_SUB_ORG && r.keyVersion === 1
    );
    expect(v1).toBeDefined();
    expect(v1?.expiresAt).not.toBeNull();
    const v1Expiry = v1?.expiresAt?.getTime() ?? 0;
    // ±60s tolerance around the 24h window.
    expect(v1Expiry).toBeGreaterThanOrEqual(before + GRACE_MS - 60_000);
    expect(v1Expiry).toBeLessThanOrEqual(after + GRACE_MS + 60_000);

    // v2 exists and is active.
    const v2 = hmacRows.find(
      (r) => r.subOrgId === TEST_SUB_ORG && r.keyVersion === 2
    );
    expect(v2).toBeDefined();
    expect(v2?.expiresAt).toBeNull();
  });

  it("first rotation on an empty sub-org inserts v1 with no expiry", async () => {
    // No seeded rows.
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keyVersion: number };
    expect(body.keyVersion).toBe(1);

    const inserted = hmacRows.filter((r) => r.subOrgId === TEST_SUB_ORG);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].keyVersion).toBe(1);
    expect(inserted[0].expiresAt).toBeNull();
  });

  it("returns 401 when HMAC verification fails and does not mutate the DB", async () => {
    mockVerifyHmacRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "Missing HMAC headers",
    });
    seedRow(TEST_SUB_ORG, 1, null);
    const snapshot = JSON.stringify(hmacRows);

    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing HMAC headers");
    expect(JSON.stringify(hmacRows)).toBe(snapshot);
  });

  it("stamps every prior active version when multiple exist", async () => {
    // Edge case: both v1 and v2 somehow lack expires_at (half-committed
    // prior rotation). After this rotation both should be stamped and v3
    // should be active.
    seedRow(TEST_SUB_ORG, 1, null);
    seedRow(TEST_SUB_ORG, 2, null);

    const before = Date.now();
    const res = await POST(makeReq());
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { keyVersion: number };
    expect(body.keyVersion).toBe(3);

    const v1 = hmacRows.find((r) => r.keyVersion === 1);
    const v2 = hmacRows.find((r) => r.keyVersion === 2);
    const v3 = hmacRows.find((r) => r.keyVersion === 3);

    for (const [label, row] of [
      ["v1", v1],
      ["v2", v2],
    ] as const) {
      expect(
        row?.expiresAt,
        `${label} should have grace expiry`
      ).not.toBeNull();
      const ts = row?.expiresAt?.getTime() ?? 0;
      expect(ts).toBeGreaterThanOrEqual(before + GRACE_MS - 60_000);
      expect(ts).toBeLessThanOrEqual(after + GRACE_MS + 60_000);
    }
    expect(v3?.expiresAt).toBeNull();
  });

  it("returns 500 INTERNAL and logs via logSystemError when DB select throws", async () => {
    dbState.throwOnSelect = true;
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("INTERNAL");
    expect(body.error).toBe("Rotate failed");
    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [category, message, _err, meta] = vi.mocked(logSystemError).mock
      .calls[0] as [string, string, unknown, Record<string, string>];
    expect(category).toBe("database");
    expect(message).toContain("/rotate-hmac");
    expect(meta).toMatchObject({
      endpoint: "/api/agentic-wallet/rotate-hmac",
      subOrgId: TEST_SUB_ORG,
    });
  });
});
