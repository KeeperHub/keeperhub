/**
 * Wave 0 RED scaffold for lib/agentic-wallet/provision.ts.
 *
 * Contract anchors:
 *   - 33-CONTEXT.md Resolution #1 (single EVM derivation path m/44'/60'/0'/0/0)
 *   - 33-RESEARCH.md Pattern 1 (lines 225-297) -- createSubOrganization shape
 *   - 33-RESEARCH.md Pattern 2 (3 x createPolicy, EFFECT_DENY, empty consensus)
 *
 * Baseline: every case throws because provisionAgenticWallet is a stub.
 * Plan 33-01b flips this suite GREEN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateSubOrg,
  mockCreatePolicy,
  mockGetPolicies,
  mockDeletePolicy,
  mockInsertAgenticWallets,
  mockInsertCredits,
  mockInsertHmacSecret,
  mockInsertValues,
  mockInsertReturning,
  mockTransaction,
  mockTxState,
} = vi.hoisted(() => {
  type TxState = {
    // Phase 37 Wave 4 Task 19: the db.transaction mock builds a scratch
    // buffer of pending inserts and only flushes them to the table-level
    // mocks when the callback resolves. If the callback rejects, the
    // buffer is dropped — mirroring Postgres rollback semantics so tests
    // can assert `mockInsertAgenticWallets` was NOT called after a
    // mid-txn failure.
    pending: Array<{ table: string; payload: unknown }>;
    // Allow tests to force a specific insert target to throw inside the
    // transaction (e.g. simulate credit FK violation). Keyed by table name.
    forceThrowOn: Record<string, Error | undefined>;
  };
  const insertValues = vi.fn();
  const insertReturning = vi.fn();
  const createSubOrg = vi.fn();
  const createPolicy = vi.fn();
  const getPolicies = vi.fn();
  const deletePolicy = vi.fn();
  const insertAgenticWallets = vi.fn();
  const insertCredits = vi.fn();
  const insertHmacSecret = vi.fn();
  const txState: TxState = { pending: [], forceThrowOn: {} };
  const transaction = vi.fn(
    async (
      cb: (tx: {
        insert: (table: { _tableName?: string }) => {
          values: (payload: unknown) => Promise<void>;
        };
      }) => Promise<void>
    ): Promise<void> => {
      txState.pending = [];
      const tx = {
        insert: (table: {
          _tableName?: string;
        }): {
          values: (payload: unknown) => Promise<void>;
        } => {
          const name = table?._tableName ?? "unknown";
          return {
            values: (payload: unknown): Promise<void> => {
              const forced = txState.forceThrowOn[name];
              if (forced) {
                return Promise.reject(forced);
              }
              txState.pending.push({ table: name, payload });
              return Promise.resolve();
            },
          };
        },
      };
      try {
        await cb(tx);
      } catch (err) {
        // Rollback: drop the buffered inserts without flushing to table mocks.
        txState.pending = [];
        throw err;
      }
      // Commit: flush buffered inserts to the table-level dispatchers so the
      // assertions on mockInsertAgenticWallets / mockInsertCredits fire.
      for (const entry of txState.pending) {
        if (entry.table === "agentic_wallets") {
          insertAgenticWallets(entry.payload);
        } else if (entry.table === "agentic_wallet_credits") {
          insertCredits(entry.payload);
        }
        insertValues(entry.table, entry.payload);
      }
      txState.pending = [];
    }
  );
  return {
    mockCreateSubOrg: createSubOrg,
    mockCreatePolicy: createPolicy,
    mockGetPolicies: getPolicies,
    mockDeletePolicy: deletePolicy,
    mockInsertAgenticWallets: insertAgenticWallets,
    mockInsertCredits: insertCredits,
    mockInsertHmacSecret: insertHmacSecret,
    mockInsertValues: insertValues,
    mockInsertReturning: insertReturning,
    mockTransaction: transaction,
    mockTxState: txState,
  };
});

// Use a function expression (not arrow) so `new Turnkey(...)` inside
// lib/turnkey/agentic-wallet.ts treats the mock as a constructor. vitest 4
// does not auto-wrap arrow-function mock implementations with [[Construct]].
vi.mock("@turnkey/sdk-server", () => ({
  Turnkey: vi.fn(function TurnkeyMock(this: unknown): {
    apiClient: () => {
      createSubOrganization: typeof mockCreateSubOrg;
      createPolicy: typeof mockCreatePolicy;
      getPolicies: typeof mockGetPolicies;
      deletePolicy: typeof mockDeletePolicy;
    };
  } {
    return {
      apiClient: () => ({
        createSubOrganization: mockCreateSubOrg,
        createPolicy: mockCreatePolicy,
        getPolicies: mockGetPolicies,
        deletePolicy: mockDeletePolicy,
      }),
    };
  }),
}));

// Route DB inserts through table-keyed dispatchers so tests can assert on which
// table received what payload. The stub helper imports `db` from "@/lib/db".
type DbInsertTarget = { _tableName?: string };

vi.mock("@/lib/db", () => ({
  db: {
    // Direct (non-transactional) insert path is still used by
    // insertHmacSecret in production; the provision path now only goes
    // through db.transaction, but we keep this stub working so other
    // helpers that may hang off `db` in the future don't silently break.
    insert: (table: DbInsertTarget): unknown => {
      const name = table?._tableName ?? "unknown";
      const inserter =
        name === "agentic_wallets"
          ? mockInsertAgenticWallets
          : mockInsertCredits;
      return {
        values: (payload: unknown): unknown => {
          inserter(payload);
          mockInsertValues(name, payload);
          return {
            returning: mockInsertReturning,
          };
        },
      };
    },
    transaction: mockTransaction,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  agenticWallets: { _tableName: "agentic_wallets" },
  agenticWalletCredits: { _tableName: "agentic_wallet_credits" },
  agenticWalletHmacSecrets: { _tableName: "agentic_wallet_hmac_secrets" },
}));

// Phase 37 Wave 4 Task 19: provision now calls insertHmacSecret(subOrgId, 1,
// plaintext) after the wallet+credit txn commits. Mock the secret store so
// the unit test doesn't need AGENTIC_WALLET_HMAC_KMS_KEY or the AES-GCM
// envelope path — that lives in agentic-wallet-hmac.test.ts.
vi.mock("@/lib/agentic-wallet/hmac-secret-store", () => ({
  insertHmacSecret: mockInsertHmacSecret,
}));

const { provisionAgenticWallet } = await import(
  "@/lib/agentic-wallet/provision"
);
const { BASELINE_POLICIES } = await import("@/lib/agentic-wallet/policy");

const MOCK_SUB_ORG_ID = "subOrg_123";
const MOCK_WALLET_ADDRESS = "0xabc000000000000000000000000000000000dead";
const EVM_PATH = "m/44'/60'/0'/0/0";
const HEX_64_RE = /^[0-9a-f]{64}$/;

describe("provisionAgenticWallet", () => {
  beforeEach(() => {
    process.env.TURNKEY_API_PUBLIC_KEY = "test-pub";
    process.env.TURNKEY_API_PRIVATE_KEY = "test-priv";
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    mockCreateSubOrg.mockReset();
    mockCreatePolicy.mockReset();
    mockGetPolicies.mockReset();
    mockDeletePolicy.mockReset();
    mockInsertAgenticWallets.mockReset();
    mockInsertCredits.mockReset();
    mockInsertHmacSecret.mockReset();
    mockInsertHmacSecret.mockResolvedValue(undefined);
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();
    mockTxState.forceThrowOn = {};

    mockCreateSubOrg.mockResolvedValue({
      subOrganizationId: MOCK_SUB_ORG_ID,
      wallet: {
        walletId: "wallet_123",
        addresses: [MOCK_WALLET_ADDRESS],
      },
    });
    // REVIEW HI-04: createPolicy returns a policyId; getPolicies supplies
    // the post-condition list with all baseline policy names.
    let policyCounter = 0;
    mockCreatePolicy.mockImplementation(async () => {
      policyCounter += 1;
      return {
        activity: {
          id: `act_${policyCounter}`,
          status: "ACTIVITY_STATUS_COMPLETED",
        },
        policyId: `policy_${policyCounter}`,
      };
    });
    mockGetPolicies.mockResolvedValue({
      policies: BASELINE_POLICIES.map((p) => ({
        policyName: p.policyName,
        effect: p.effect,
      })),
    });
    mockDeletePolicy.mockResolvedValue({});
    mockInsertReturning.mockResolvedValue([{ id: "wallet-row-id" }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls createSubOrganization exactly once with the anonymous-operator shape", async () => {
    await provisionAgenticWallet();
    expect(mockCreateSubOrg).toHaveBeenCalledTimes(1);
    const args = mockCreateSubOrg.mock.calls[0]?.[0];
    expect(args.rootQuorumThreshold).toBe(1);
    expect(args.rootUsers?.[0]?.userName).toBe("keeperhub-operator");
    expect(args.rootUsers?.[0]?.userEmail).toBeUndefined();
    expect(args.disableEmailAuth).toBe(true);
    expect(args.disableEmailRecovery).toBe(true);
    expect(args.disableSmsAuth).toBe(true);
    expect(args.disableOtpEmailAuth).toBe(true);
  });

  it("uses the single EVM derivation path m/44'/60'/0'/0/0 (CONTEXT Resolution #1)", async () => {
    await provisionAgenticWallet();
    const args = mockCreateSubOrg.mock.calls[0]?.[0];
    expect(args.wallet?.accounts?.[0]?.path).toBe(EVM_PATH);
    expect(args.wallet?.accounts?.[0]?.addressFormat).toBe(
      "ADDRESS_FORMAT_ETHEREUM"
    );
  });

  it("applies all baseline policies, each EFFECT_DENY with consensus 'true'", async () => {
    await provisionAgenticWallet();
    expect(mockCreatePolicy).toHaveBeenCalledTimes(BASELINE_POLICIES.length);
    for (const call of mockCreatePolicy.mock.calls) {
      const arg = call[0];
      expect(arg.organizationId).toBe(MOCK_SUB_ORG_ID);
      expect(arg.effect).toBe("EFFECT_DENY");
      expect(arg.consensus).toBe("true");
    }
  });

  it("inserts an agentic_wallets row with subOrgId + both addresses but NOT the legacy hmac_secret column (Phase 37 Wave 4 Task 19)", async () => {
    await provisionAgenticWallet();
    expect(mockInsertAgenticWallets).toHaveBeenCalledTimes(1);
    const payload = mockInsertAgenticWallets.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload.subOrgId).toBe(MOCK_SUB_ORG_ID);
    // Per CONTEXT Resolution #1 the single EVM address is mirrored onto
    // both Base and Tempo columns. Both must equal MOCK_WALLET_ADDRESS.
    expect(payload.walletAddressBase).toBe(MOCK_WALLET_ADDRESS);
    expect(payload.walletAddressTempo).toBe(MOCK_WALLET_ADDRESS);
    // Phase 37 Wave 4 Task 19: legacy hmac_secret column is no longer
    // written. The schema still carries the column (drop deferred to
    // KEEP-NEW-3 per SPEC.md line 117) but new wallets leave it NULL.
    expect("hmacSecret" in payload).toBe(false);
  });

  it("writes the HMAC secret to agentic_wallet_hmac_secrets at keyVersion=1 after the txn commits", async () => {
    const result = await provisionAgenticWallet();
    expect(mockInsertHmacSecret).toHaveBeenCalledTimes(1);
    const [subOrg, keyVersion, plaintext] =
      mockInsertHmacSecret.mock.calls[0] ?? [];
    expect(subOrg).toBe(MOCK_SUB_ORG_ID);
    expect(keyVersion).toBe(1);
    // The plaintext handed to the store must match the one returned to the
    // caller (single-channel contract per T-33-02).
    expect(plaintext).toBe(result.hmacSecret);
    expect(plaintext).toMatch(HEX_64_RE);
  });

  it("wraps wallet + credit inserts inside a single db.transaction (atomic)", async () => {
    await provisionAgenticWallet();
    expect(mockInsertAgenticWallets).toHaveBeenCalledTimes(1);
    expect(mockInsertCredits).toHaveBeenCalledTimes(1);
    // mockTransaction is the fn that backs db.transaction. One call ==
    // one (wallet + credit) atomic unit.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("rolls the wallet insert back if the credit insert throws inside the txn", async () => {
    const creditErr = new Error("credits unique violation");
    mockTxState.forceThrowOn.agentic_wallet_credits = creditErr;
    await expect(provisionAgenticWallet()).rejects.toThrow(
      "credits unique violation"
    );
    // Rollback semantics: the wallet insert was buffered but never flushed
    // to the table-level mock, so the assertion is that NO wallet row was
    // observed despite the insert having been "called" inside the callback.
    expect(mockInsertAgenticWallets).not.toHaveBeenCalled();
    expect(mockInsertCredits).not.toHaveBeenCalled();
    // Task 19: HMAC insert must NOT fire when the txn rolls back.
    expect(mockInsertHmacSecret).not.toHaveBeenCalled();
  });

  it("propagates a failure from insertHmacSecret (AGENTIC_WALLET_HMAC_INSERT_FAILED)", async () => {
    const hmacErr = new Error("kms unavailable");
    mockInsertHmacSecret.mockReset();
    mockInsertHmacSecret.mockRejectedValueOnce(hmacErr);
    await expect(provisionAgenticWallet()).rejects.toThrow("kms unavailable");
    // The wallet + credit txn committed before the HMAC insert was attempted,
    // so their mocks should have been called exactly once each.
    expect(mockInsertAgenticWallets).toHaveBeenCalledTimes(1);
    expect(mockInsertCredits).toHaveBeenCalledTimes(1);
    // And insertHmacSecret was called before the rejection surfaced.
    expect(mockInsertHmacSecret).toHaveBeenCalledTimes(1);
  });

  it("inserts an agentic_wallet_credits row for 50 USDC cents ($0.50 seed credit)", async () => {
    await provisionAgenticWallet();
    expect(mockInsertCredits).toHaveBeenCalledTimes(1);
    const payload = mockInsertCredits.mock.calls[0]?.[0];
    expect(payload.subOrgId).toBe(MOCK_SUB_ORG_ID);
    expect(payload.amountUsdcCents).toBe(50);
  });

  it("returns { subOrgId, walletAddress, hmacSecret } on success (single walletAddress per CONTEXT Resolution #1)", async () => {
    const result = await provisionAgenticWallet();
    expect(result.subOrgId).toBe(MOCK_SUB_ORG_ID);
    expect(result.walletAddress).toBe(MOCK_WALLET_ADDRESS);
    expect(typeof result.hmacSecret).toBe("string");
    expect(result.hmacSecret.length).toBe(64);
  });

  it("re-throws when createSubOrganization fails and does not write to agentic_wallets", async () => {
    mockCreateSubOrg.mockRejectedValueOnce(new Error("TURNKEY_UPSTREAM: 5xx"));
    await expect(provisionAgenticWallet()).rejects.toThrow("TURNKEY_UPSTREAM");
    expect(mockInsertAgenticWallets).not.toHaveBeenCalled();
  });

  it("re-throws when the first createPolicy fails", async () => {
    mockCreatePolicy.mockRejectedValueOnce(new Error("policy: bad DSL"));
    await expect(provisionAgenticWallet()).rejects.toThrow();
  });
});
