/**
 * Wave 0 RED scaffold for lib/agentic-wallet/hmac.ts.
 *
 * Contract anchor: .planning/phases/33-provisioning-signing-apis/33-RESEARCH.md
 * Pattern 5 (lines 474-531).
 *
 *   signingString = `${method}\n${path}\n${sha256_hex(body)}\n${timestamp}`
 *   signature     = hex(hmac_sha256(secret, signingString))
 *
 * Replay window: 300 s. Required headers: X-KH-Sub-Org, X-KH-Timestamp, X-KH-Signature.
 * Baseline: every `it` block throws because the helper bodies throw
 * "not yet implemented" stubs. Plan 33-01a flips this suite GREEN.
 */
import { createHash, createHmac } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type HmacSecretRow = {
  subOrgId: string;
  keyVersion: number;
  secretCiphertext: string;
  expiresAt: Date | null;
};

const { mockLookupSecret, hmacSecretRows } = vi.hoisted(() => ({
  mockLookupSecret:
    vi.fn<
      (
        subOrgId: string,
        keyVersion?: number
      ) => Promise<{ secret: string; keyVersion: number } | null>
    >(),
  hmacSecretRows: [] as HmacSecretRow[],
}));

vi.mock("@/lib/agentic-wallet/hmac-secret-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/agentic-wallet/hmac-secret-store")
  >("@/lib/agentic-wallet/hmac-secret-store");
  return {
    ...actual,
    // Override only what the verifyHmacRequest suite needs to stub.
    lookupHmacSecret: mockLookupSecret,
    // Fix-pack-2 R3: verifyHmacRequest now uses listActiveHmacSecrets on the
    // unpinned path so the rotation grace window actually works. The shim
    // delegates to the same mockLookupSecret fixture so existing
    // mockResolvedValue setups keep driving the candidate list. Tests that
    // need to exercise multi-version iteration can set
    // mockLookupSecret.mockImplementation to return different shapes per call.
    listActiveHmacSecrets: async (
      subOrgId: string
    ): Promise<{ secret: string; keyVersion: number }[]> => {
      const one = await mockLookupSecret(subOrgId, undefined);
      return one ? [one] : [];
    },
  };
});

// Minimal in-memory drizzle-shaped mock of @/lib/db. The real
// hmac-secret-store.ts queries agenticWalletHmacSecrets via
//   db.select({...}).from(t).where(w).orderBy(c)
// and
//   db.update(t).set(v).where(w)
// The mock ignores the SQL predicates and instead filters by the arguments
// the tests set up (sub_org_id + active expiresAt), which mirrors the
// runtime filter. This keeps the unit test DB-free while still exercising
// the envelope-encryption + lazy-backfill code paths.
vi.mock("@/lib/db", () => {
  type TableMarker = { __table: "agentic_wallet_hmac_secrets" };
  const isHmacTable = (t: unknown): t is TableMarker =>
    typeof t === "object" && t !== null && "__table" in t;

  const runSelect = (): Promise<
    Array<{ keyVersion: number; secretCiphertext: string }>
  > => {
    const now = Date.now();
    const active = hmacSecretRows.filter(
      (r) => r.expiresAt === null || r.expiresAt.getTime() > now
    );
    active.sort((a, b) => a.keyVersion - b.keyVersion);
    return Promise.resolve(
      active.map((r) => ({
        keyVersion: r.keyVersion,
        secretCiphertext: r.secretCiphertext,
      }))
    );
  };

  return {
    db: {
      select: () => ({
        from: (t: unknown) => ({
          where: (_w: unknown) => ({
            orderBy: (_c: unknown) => {
              if (!isHmacTable(t)) {
                return Promise.resolve([]);
              }
              return runSelect();
            },
          }),
        }),
      }),
      update: (t: unknown) => ({
        set: (values: { secretCiphertext?: string }) => ({
          where: (_w: unknown): Promise<void> => {
            if (!isHmacTable(t)) {
              return Promise.resolve();
            }
            // The mock can't read the drizzle predicate, so apply the
            // update to every row where the ciphertext still carries the
            // backfill marker — matches the lazy-backfill semantics the
            // test exercises.
            for (const row of hmacSecretRows) {
              if (
                row.secretCiphertext.startsWith("__PLAINTEXT_BACKFILL__:") &&
                values.secretCiphertext !== undefined
              ) {
                row.secretCiphertext = values.secretCiphertext;
              }
            }
            return Promise.resolve();
          },
        }),
      }),
      insert: (_t: unknown) => ({
        values: (_v: unknown): Promise<void> => Promise.resolve(),
      }),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  agenticWalletHmacSecrets: {
    __table: "agentic_wallet_hmac_secrets",
    subOrgId: "sub_org_id",
    keyVersion: "key_version",
    secretCiphertext: "secret_ciphertext",
    expiresAt: "expires_at",
  },
}));

const { computeSignature, verifyHmacRequest } = await import(
  "@/lib/agentic-wallet/hmac"
);

const TEST_SECRET = "deadbeef";
const TEST_SUB_ORG = "subOrg_test_123";
const TEST_PATH = "/api/agentic-wallet/sign";
const FROZEN_NOW_ISO = "2026-04-21T00:00:00Z";
const FROZEN_NOW_UNIX = Math.floor(
  new Date(FROZEN_NOW_ISO).getTime() / 1000
).toString();

// REVIEW HI-05: subOrgId is bound into the signed string.
function signingString(
  method: string,
  path: string,
  subOrgId: string,
  body: string,
  ts: string
): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return `${method}\n${path}\n${subOrgId}\n${digest}\n${ts}`;
}

function expectedSig(secret: string, str: string): string {
  return createHmac("sha256", secret).update(str).digest("hex");
}

function buildRequest(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): Request {
  const method = opts.method ?? "POST";
  const path = opts.path ?? TEST_PATH;
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: opts.headers ?? {},
  });
}

describe("computeSignature", () => {
  it("returns a lowercase hex string of 64 characters (sha256 length)", () => {
    const sig = computeSignature(
      TEST_SECRET,
      "POST",
      TEST_PATH,
      TEST_SUB_ORG,
      '{"chain":"base"}',
      FROZEN_NOW_UNIX
    );
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a node:crypto-computed HMAC-SHA256 over the signing string", () => {
    const body = '{"chain":"base"}';
    const ts = "1713600000";
    const expected = expectedSig(
      TEST_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, ts)
    );
    const actual = computeSignature(
      TEST_SECRET,
      "POST",
      TEST_PATH,
      TEST_SUB_ORG,
      body,
      ts
    );
    expect(actual).toBe(expected);
  });

  it("produces different signatures for different bodies (sha256 sensitivity)", () => {
    const ts = "1713600000";
    const a = computeSignature(
      TEST_SECRET,
      "POST",
      TEST_PATH,
      TEST_SUB_ORG,
      "{}",
      ts
    );
    const b = computeSignature(
      TEST_SECRET,
      "POST",
      TEST_PATH,
      TEST_SUB_ORG,
      '{"x":1}',
      ts
    );
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different subOrgIds (HI-05 binding)", () => {
    const body = '{"chain":"base"}';
    const ts = "1713600000";
    const a = computeSignature(
      TEST_SECRET,
      "POST",
      TEST_PATH,
      "subOrg_A",
      body,
      ts
    );
    const b = computeSignature(
      TEST_SECRET,
      "POST",
      TEST_PATH,
      "subOrg_B",
      body,
      ts
    );
    expect(a).not.toBe(b);
  });
});

describe("verifyHmacRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW_ISO));
    mockLookupSecret.mockReset();
    mockLookupSecret.mockResolvedValue({
      secret: TEST_SECRET,
      keyVersion: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns ok:true with subOrgId when headers and signature match", async () => {
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      TEST_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subOrgId).toBe(TEST_SUB_ORG);
    }
  });

  it("returns ok:false status:401 when signature was computed with a different subOrgId (HI-05)", async () => {
    const body = '{"chain":"base"}';
    // Caller signs binding subOrg_B but sends subOrg_A in the header. Even if
    // the same secret were accepted by lookup (it isn't today, but HI-05 guards
    // the refactor), the signature must not verify.
    const sig = expectedSig(
      TEST_SECRET,
      signingString("POST", TEST_PATH, "subOrg_B", body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns ok:false status:401 when X-KH-Signature header is missing", async () => {
    const body = '{"chain":"base"}';
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns ok:false status:401 when timestamp is more than 300s old", async () => {
    const body = '{"chain":"base"}';
    const staleTs = String(Number(FROZEN_NOW_UNIX) - 301);
    const sig = expectedSig(
      TEST_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, staleTs)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": staleTs,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns ok:false status:401 when timestamp is more than 300s in the future", async () => {
    const body = '{"chain":"base"}';
    const futureTs = String(Number(FROZEN_NOW_UNIX) + 301);
    const sig = expectedSig(
      TEST_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, futureTs)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": futureTs,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns ok:false status:404 when sub-org lookup returns null", async () => {
    mockLookupSecret.mockResolvedValueOnce(null);
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      TEST_SECRET,
      signingString(
        "POST",
        TEST_PATH,
        "subOrg_does_not_exist",
        body,
        FROZEN_NOW_UNIX
      )
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": "subOrg_does_not_exist",
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it("returns ok:false status:401 when signature is same length but wrong bytes (timingSafeEqual path)", async () => {
    const body = '{"chain":"base"}';
    // 64 hex chars = same length as a valid sha256 HMAC, but wrong bytes.
    const wrongSig = "a".repeat(64);
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": wrongSig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns ok:false status:401 when signature length differs from expected (guard clause)", async () => {
    const body = '{"chain":"base"}';
    // Wrong length — must not throw inside timingSafeEqual; guard clause trips first.
    const shortSig = "deadbeef";
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": shortSig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns ok:false status:401 when X-KH-Sub-Org header is missing", async () => {
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      TEST_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns ok:false status:401 when X-KH-Timestamp is non-numeric garbage", async () => {
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      TEST_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, "not-a-number")
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": "not-a-number",
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });
});

describe("verifyHmacRequest X-KH-Key-Version header", () => {
  // Versioned secrets keyed on the pin. v1 is still active but superseded; v2
  // is the highest active. Mirrors a mid-rotation state where v1 has a grace
  // window (expires_at = now + 24h) and v2 is the new default (expires_at
  // null).
  const V1_SECRET = "v1secret";
  const V2_SECRET = "v2secret";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW_ISO));
    mockLookupSecret.mockReset();
    // Multi-version lookup: honours the pin when passed, otherwise returns the
    // highest active (v2). Mirrors the real hmac-secret-store contract.
    mockLookupSecret.mockImplementation(
      (_subOrgId: string, keyVersion?: number) => {
        if (keyVersion === 1) {
          return Promise.resolve({ secret: V1_SECRET, keyVersion: 1 });
        }
        if (keyVersion === 2 || keyVersion === undefined) {
          return Promise.resolve({ secret: V2_SECRET, keyVersion: 2 });
        }
        return Promise.resolve(null);
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies with v1 secret when X-KH-Key-Version: 1 is supplied", async () => {
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      V1_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
        "X-KH-Key-Version": "1",
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subOrgId).toBe(TEST_SUB_ORG);
    }
  });

  it("rejects v1-signed request when no X-KH-Key-Version header is sent (lookup defaults to v2)", async () => {
    const body = '{"chain":"base"}';
    // Sign with v1 but omit the pin: the verifier pulls v2 (highest active) and
    // the signature no longer matches.
    const sig = expectedSig(
      V1_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it.each([
    "abc",
    "0",
    "-1",
    "1.5",
    " ",
    "1e2",
    "01",
  ])("rejects invalid X-KH-Key-Version value %j with 401 Invalid key version", async (badVersion) => {
    const body = '{"chain":"base"}';
    // Signature correctness is irrelevant — the version guard fires first.
    const sig = expectedSig(
      V1_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
        "X-KH-Key-Version": badVersion,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("Invalid key version");
    }
  });

  it("returns ok:false status:404 when pinned X-KH-Key-Version does not exist", async () => {
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      V1_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
        "X-KH-Key-Version": "5",
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe("Unknown sub-org");
    }
  });

  it("passes the parsed pinned version through to lookupHmacSecret", async () => {
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      V1_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
        "X-KH-Key-Version": "1",
      },
    });
    await verifyHmacRequest(request, body);
    expect(mockLookupSecret).toHaveBeenCalledWith(TEST_SUB_ORG, 1);
  });

  it("omits the pin when the header is absent (highest-active selection)", async () => {
    const body = '{"chain":"base"}';
    const sig = expectedSig(
      V2_SECRET,
      signingString("POST", TEST_PATH, TEST_SUB_ORG, body, FROZEN_NOW_UNIX)
    );
    const request = buildRequest({
      headers: {
        "X-KH-Sub-Org": TEST_SUB_ORG,
        "X-KH-Timestamp": FROZEN_NOW_UNIX,
        "X-KH-Signature": sig,
      },
    });
    const result = await verifyHmacRequest(request, body);
    expect(result.ok).toBe(true);
    expect(mockLookupSecret).toHaveBeenCalledWith(TEST_SUB_ORG, undefined);
  });
});

describe("hmac-secret-store envelope encryption (Phase 37 fix C2)", () => {
  beforeAll(() => {
    process.env.AGENTIC_WALLET_HMAC_KMS_KEY = Buffer.alloc(32, 1).toString(
      "base64"
    );
  });

  beforeEach(() => {
    hmacSecretRows.length = 0;
  });

  it("encrypt/decrypt round-trips a known secret", async () => {
    const { encryptSecret, decryptSecret } = await vi.importActual<
      typeof import("@/lib/agentic-wallet/hmac-secret-store")
    >("@/lib/agentic-wallet/hmac-secret-store");
    const secret = "deadbeef".repeat(8); // 64 hex chars
    const ct = encryptSecret(secret, "so_test", 1);
    expect(ct).not.toContain(secret);
    expect(ct.split(":").length).toBe(3);
    expect(decryptSecret(ct, "so_test", 1)).toBe(secret);
  });

  it("decryptSecret detects + strips the __PLAINTEXT_BACKFILL__ marker", async () => {
    const { decryptSecret } = await vi.importActual<
      typeof import("@/lib/agentic-wallet/hmac-secret-store")
    >("@/lib/agentic-wallet/hmac-secret-store");
    // Backfill prefix is stripped BEFORE AES-GCM, so AAD is irrelevant here.
    expect(decryptSecret("__PLAINTEXT_BACKFILL__:abc123", "so_test", 1)).toBe(
      "abc123"
    );
  });

  it("rejects ciphertext with bad auth tag", async () => {
    const { encryptSecret, decryptSecret } = await vi.importActual<
      typeof import("@/lib/agentic-wallet/hmac-secret-store")
    >("@/lib/agentic-wallet/hmac-secret-store");
    const ct = encryptSecret("secret", "so_test", 1);
    const [iv, _tag, body] = ct.split(":");
    const tampered = `${iv}:${Buffer.alloc(16, 0).toString("base64")}:${body}`;
    expect(() => decryptSecret(tampered, "so_test", 1)).toThrow();
  });

  it("rejects ciphertext replayed into a different sub-org (AAD binding)", async () => {
    const { encryptSecret, decryptSecret } = await vi.importActual<
      typeof import("@/lib/agentic-wallet/hmac-secret-store")
    >("@/lib/agentic-wallet/hmac-secret-store");
    const ct = encryptSecret("secret-A", "so_a", 1);
    // Same envelope, same key version — but decrypting as if it belonged to
    // a different sub-org must fail the GCM tag check.
    expect(() => decryptSecret(ct, "so_b", 1)).toThrow();
  });

  it("rejects ciphertext replayed into a different keyVersion (AAD binding)", async () => {
    const { encryptSecret, decryptSecret } = await vi.importActual<
      typeof import("@/lib/agentic-wallet/hmac-secret-store")
    >("@/lib/agentic-wallet/hmac-secret-store");
    const ct = encryptSecret("secret-v1", "so_a", 1);
    // Same sub-org, same envelope — but claiming a different key version
    // must fail the GCM tag check.
    expect(() => decryptSecret(ct, "so_a", 2)).toThrow();
  });

  it("lookupHmacSecret returns highest active version, skipping expired rows", async () => {
    const { lookupHmacSecret: realLookup, encryptSecret } =
      await vi.importActual<
        typeof import("@/lib/agentic-wallet/hmac-secret-store")
      >("@/lib/agentic-wallet/hmac-secret-store");

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    hmacSecretRows.push(
      {
        subOrgId: "subOrg_versioned",
        keyVersion: 1,
        secretCiphertext: encryptSecret("v1-secret", "subOrg_versioned", 1),
        expiresAt: past,
      },
      {
        subOrgId: "subOrg_versioned",
        keyVersion: 2,
        secretCiphertext: encryptSecret("v2-secret", "subOrg_versioned", 2),
        expiresAt: null,
      },
      {
        subOrgId: "subOrg_versioned",
        keyVersion: 3,
        secretCiphertext: encryptSecret("v3-secret", "subOrg_versioned", 3),
        expiresAt: future,
      }
    );

    const result = await realLookup("subOrg_versioned");
    expect(result).not.toBeNull();
    expect(result?.keyVersion).toBe(3);
    expect(result?.secret).toBe("v3-secret");
  });

  it("lookupHmacSecret lazy-backfills __PLAINTEXT_BACKFILL__ rows", async () => {
    const { lookupHmacSecret: realLookup } = await vi.importActual<
      typeof import("@/lib/agentic-wallet/hmac-secret-store")
    >("@/lib/agentic-wallet/hmac-secret-store");

    const hexSecret = "feedface".repeat(8); // 64 hex chars
    hmacSecretRows.push({
      subOrgId: "subOrg_backfill",
      keyVersion: 1,
      secretCiphertext: `__PLAINTEXT_BACKFILL__:${hexSecret}`,
      expiresAt: null,
    });

    const result = await realLookup("subOrg_backfill");
    expect(result).not.toBeNull();
    expect(result?.keyVersion).toBe(1);
    expect(result?.secret).toBe(hexSecret);

    const rowAfter = hmacSecretRows[0];
    expect(
      rowAfter.secretCiphertext.startsWith("__PLAINTEXT_BACKFILL__:")
    ).toBe(false);
    expect(rowAfter.secretCiphertext.split(":").length).toBe(3);
    expect(rowAfter.secretCiphertext).not.toContain(hexSecret);
  });
});
