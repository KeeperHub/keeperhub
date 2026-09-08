/**
 * Integration tests for POST /api/agentic-wallet/feedback (KEEP-515).
 *
 * The KEEP-515 bug: the route INSERTed a feedback row, then signed +
 * broadcast an on-chain giveFeedback() tx. If the broadcast failed the row
 * persisted with a NULL txHash and the old `ensureNotAlreadyRated()` guard
 * rejected EVERY subsequent retry with 409 ALREADY_RATED -- the caller was
 * permanently locked out.
 *
 * The fix replaces that guard with `findExistingFeedback()`:
 *   - existing row WITH a non-empty txHash  -> 409 ALREADY_RATED (real rating)
 *   - existing row with NULL/empty txHash   -> REUSE it (UPDATE status back to
 *       "pending", clear `error`, keep the original id + createdAt so the
 *       on-chain feedbackURI stays stable), skip the INSERT, retry sign+cast
 *   - no existing row                       -> INSERT as before
 *
 * These tests assert that contract with exact values. They follow the
 * sibling sign-route suite's mocking shape: vi.hoisted() fns,
 * @turnkey/sdk-server constructable mock, a real verifyHmacRequest over a
 * mocked hmac-secret-store, and a buildHmacHeaders() request signer. The db
 * mock is EXTENDED beyond the sign-route's select-only stub to also cover
 * the insert().values().returning() and update().set().where() chains the
 * feedback route uses. signEthereumTransaction / broadcastSignedTransaction
 * are mocked at the sign-eth-tx boundary, and viem's createPublicClient is
 * stubbed so buildAndSignTx's live RPC reads (nonce/gas/fees) are canned.
 */
import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  KEEPERHUB_ERC_8004_AGENT_ID,
} from "@/lib/agentic-wallet/constants";

const TEST_HMAC_SECRET =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_SUB_ORG = "subOrg_feedback_test";
const TEST_WALLET = "0x1111111111111111111111111111111111111111";
const TEST_EXECUTION_ID = "exec_test_1";
const TEST_WORKFLOW_ID = "wf_test_1";
const NEW_FEEDBACK_ID = "fb_new_1";
const EXISTING_FEEDBACK_ID = "fb_existing_1";
const NEW_CREATED_AT = new Date("2026-05-14T00:00:00.000Z");
const EXISTING_CREATED_AT = new Date("2026-05-01T12:00:00.000Z");
const BROADCAST_TX_HASH =
  "0xabc1230000000000000000000000000000000000000000000000000000000000";

type MockFn = ReturnType<typeof vi.fn>;

const {
  mockSelectLimit,
  mockInsertReturning,
  mockUpdateSet,
  mockUpdateWhere,
  mockLookupSecret,
  mockSignEthereumTransaction,
  mockBroadcastSignedTransaction,
  mockGetBalance,
} = vi.hoisted(
  (): {
    mockSelectLimit: MockFn;
    mockInsertReturning: MockFn;
    mockUpdateSet: MockFn;
    mockUpdateWhere: MockFn;
    mockLookupSecret: MockFn;
    mockSignEthereumTransaction: MockFn;
    mockBroadcastSignedTransaction: MockFn;
    mockGetBalance: MockFn;
  } => {
    const updateWhere = vi.fn();
    return {
      mockSelectLimit: vi.fn(),
      mockInsertReturning: vi.fn(),
      // .set() is a real spy so tests can assert the exact payload passed to
      // update().set(...) -- that payload IS the KEEP-515 status transition.
      mockUpdateSet: vi.fn(() => ({ where: updateWhere })),
      mockUpdateWhere: updateWhere,
      mockLookupSecret: vi.fn(),
      mockSignEthereumTransaction: vi.fn(),
      mockBroadcastSignedTransaction: vi.fn(),
      // buildAndSignTx's gas preflight reads the wallet balance; tests drive
      // it per-case (default healthy balance set in beforeEach).
      mockGetBalance: vi.fn(),
    };
  }
);

vi.mock("@turnkey/sdk-server", () => ({
  // Named function expression so `new Turnkey(...)` is constructable under
  // vitest 4.x. Arrow fns lack [[Construct]] and throw "is not a constructor".
  Turnkey: vi.fn(function TurnkeyMock(this: unknown): {
    apiClient: () => Record<string, never>;
  } {
    return { apiClient: (): Record<string, never> => ({}) };
  }),
}));

type LookupReturn = { secret: string; keyVersion: number } | null;
type LookupFn = (
  subOrgId: string,
  keyVersion?: number
) => Promise<LookupReturn>;

vi.mock("@/lib/agentic-wallet/hmac-secret-store", () => ({
  lookupHmacSecret: mockLookupSecret,
  // verifyHmacRequest uses listActiveHmacSecrets on the unpinned path. Shim
  // delegates to the same mockLookupSecret fixture so a single
  // mockResolvedValue keeps both code paths green.
  listActiveHmacSecrets: async (
    subOrgId: string
  ): Promise<{ secret: string; keyVersion: number }[]> => {
    const one = await (mockLookupSecret as unknown as LookupFn)(
      subOrgId,
      undefined
    );
    return one ? [one] : [];
  },
}));

// The feedback route hits db.select() THREE times (resolveWallet,
// verifyExecutionAndPayer, findExistingFeedback), each with a different
// chain shape; db.insert() once on the fresh path; db.update() one-to-three
// times. mockSelectLimit is a queue consumed in call order; insert.returning
// and update.where are single mocks the tests configure per case.
vi.mock("@/lib/db", () => ({
  db: {
    select: (): {
      from: () => {
        leftJoin: () => {
          leftJoin: () => { where: () => { limit: typeof mockSelectLimit } };
        };
        where: () => { limit: typeof mockSelectLimit };
      };
    } => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({ limit: mockSelectLimit }),
          }),
        }),
        where: () => ({ limit: mockSelectLimit }),
      }),
    }),
    insert: (): {
      values: () => { returning: typeof mockInsertReturning };
    } => ({
      values: () => ({ returning: mockInsertReturning }),
    }),
    update: (): { set: typeof mockUpdateSet } => ({
      set: mockUpdateSet,
    }),
  },
}));

vi.mock("@/lib/agentic-wallet/sign-eth-tx", () => ({
  signEthereumTransaction: mockSignEthereumTransaction,
  broadcastSignedTransaction: mockBroadcastSignedTransaction,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    WORKFLOW_ENGINE: "workflow_engine",
    DATABASE: "database",
    EXTERNAL_SERVICE: "external_service",
  },
  logSystemError: vi.fn(),
}));

// buildAndSignTx does live RPC reads (getTransactionCount / getBalance /
// estimateGas / estimateFeesPerGas) via viem's createPublicClient. Stub the
// client so those reads are canned; keep serializeTransaction + http real so
// the route's RLP encoding path still executes for real. getBalance is the
// hoisted mock so tests can drive the gas preflight per-case.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: (): {
      getTransactionCount: () => Promise<number>;
      getBalance: () => Promise<bigint>;
      estimateGas: () => Promise<bigint>;
      estimateFeesPerGas: () => Promise<{
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }>;
    } => ({
      getTransactionCount: async (): Promise<number> => 7,
      // vi.fn()'s loose Mock type is not assignable to the explicit
      // () => Promise<bigint> signature; cast the hoisted mock through.
      getBalance: mockGetBalance as unknown as () => Promise<bigint>,
      estimateGas: async (): Promise<bigint> => BigInt(120_000),
      estimateFeesPerGas: async (): Promise<{
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }> => ({
        maxFeePerGas: BigInt(30_000_000_000),
        maxPriorityFeePerGas: BigInt(1_500_000_000),
      }),
    }),
  };
});

process.env.TURNKEY_API_PUBLIC_KEY = "test-pub";
process.env.TURNKEY_API_PRIVATE_KEY = "test-priv";
process.env.TURNKEY_ORGANIZATION_ID = "org_test";

const { POST } = await import("@/app/api/agentic-wallet/feedback/route");

function buildHmacHeaders(
  subOrgId: string,
  method: string,
  path: string,
  body: string
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const digest = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", TEST_HMAC_SECRET)
    .update(`${method}\n${path}\n${subOrgId}\n${digest}\n${ts}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-KH-Sub-Org": subOrgId,
    "X-KH-Timestamp": ts,
    "X-KH-Signature": sig,
  };
}

const FEEDBACK_PATH = "/api/agentic-wallet/feedback";

function callFeedback(
  bodyObj: Record<string, unknown>
): ReturnType<typeof POST> {
  const body = JSON.stringify(bodyObj);
  return POST(
    new Request(`http://localhost:3000${FEEDBACK_PATH}`, {
      method: "POST",
      headers: buildHmacHeaders(TEST_SUB_ORG, "POST", FEEDBACK_PATH, body),
      body,
    }) as unknown as Parameters<typeof POST>[0]
  );
}

// Wallet row + execution+payer row are identical across every test; only the
// findExistingFeedback() result (third select) varies per case. This helper
// queues the two fixed rows then the caller-supplied third.
function queueSelects(existingFeedbackRows: unknown[]): void {
  // 1) resolveWallet
  mockSelectLimit.mockResolvedValueOnce([{ walletAddress: TEST_WALLET }]);
  // 2) verifyExecutionAndPayer -- payerAddress matches the caller wallet
  mockSelectLimit.mockResolvedValueOnce([
    {
      executionId: TEST_EXECUTION_ID,
      workflowId: TEST_WORKFLOW_ID,
      executionStatus: "success",
      workflowSlug: "test-slug",
      payerAddress: TEST_WALLET,
    },
  ]);
  // 3) findExistingFeedback
  mockSelectLimit.mockResolvedValueOnce(existingFeedbackRows);
}

const VALID_BODY = {
  executionId: TEST_EXECUTION_ID,
  value: "5",
  valueDecimals: 0,
  comment: "great run",
};

// The reuse branch must refresh EVERY input-derived field on the stranded
// row, not just status/error -- otherwise a retry commits an on-chain hash
// of the new input while /api/feedback/[id] serves the stale persisted JSON.
// This is the exact update().set(...) payload expected for a retry of
// VALID_BODY (agentChainId/agentId fall back to the platform defaults).
const REUSE_SET_PAYLOAD_FOR_VALID_BODY = {
  status: "pending",
  error: null,
  workflowId: TEST_WORKFLOW_ID,
  agentChainId: ETHEREUM_MAINNET_CHAIN_ID,
  agentId: KEEPERHUB_ERC_8004_AGENT_ID.toString(),
  value: "5",
  valueDecimals: 0,
  comment: "great run",
  txChainId: ETHEREUM_MAINNET_CHAIN_ID,
};

beforeEach(() => {
  mockSelectLimit.mockReset();
  mockInsertReturning.mockReset();
  // mockClear (not mockReset) on .set() -- keep its implementation that
  // returns { where: mockUpdateWhere }, only drop recorded calls/args.
  mockUpdateSet.mockClear();
  mockUpdateWhere.mockReset();
  mockLookupSecret.mockReset();
  mockSignEthereumTransaction.mockReset();
  mockBroadcastSignedTransaction.mockReset();
  mockGetBalance.mockReset();

  mockLookupSecret.mockResolvedValue({
    secret: TEST_HMAC_SECRET,
    keyVersion: 1,
  });
  // Fresh-path INSERT default: a brand new row id + createdAt.
  mockInsertReturning.mockResolvedValue([
    { id: NEW_FEEDBACK_ID, createdAt: NEW_CREATED_AT },
  ]);
  // update().set().where() resolves to nothing meaningful in the route.
  mockUpdateWhere.mockResolvedValue(undefined);
  // Happy-path signing + broadcast.
  mockSignEthereumTransaction.mockResolvedValue({
    signedTransaction: "0xsigned",
  });
  mockBroadcastSignedTransaction.mockResolvedValue({
    txHash: BROADCAST_TX_HASH,
  });
  // Default healthy balance (1 ETH) -- comfortably covers the canned gas
  // cost so the existing happy-path tests clear the preflight unchanged.
  mockGetBalance.mockResolvedValue(BigInt("1000000000000000000"));
});

describe("POST /api/agentic-wallet/feedback -- KEEP-515 retry recovery", () => {
  it("inserts a new row, signs + broadcasts, and returns feedbackId + txHash when no prior row exists", async () => {
    queueSelects([]); // findExistingFeedback -> null

    const res = await callFeedback(VALID_BODY);

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      feedbackId: string;
      txHash: string;
      publicUrl: string;
    };
    expect(json.feedbackId).toBe(NEW_FEEDBACK_ID);
    expect(json.txHash).toBe(BROADCAST_TX_HASH);
    expect(json.publicUrl).toContain(`/api/feedback/${NEW_FEEDBACK_ID}`);

    // Fresh path: INSERT happened exactly once, sign + broadcast both ran.
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
    expect(mockSignEthereumTransaction).toHaveBeenCalledTimes(1);
    expect(mockBroadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 409 ALREADY_RATED and does NOT broadcast when a prior row already has a txHash", async () => {
    queueSelects([
      {
        id: EXISTING_FEEDBACK_ID,
        txHash: BROADCAST_TX_HASH,
        status: "broadcast",
        createdAt: EXISTING_CREATED_AT,
      },
    ]);

    const res = await callFeedback(VALID_BODY);

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; feedbackId: string };
    expect(json.code).toBe("ALREADY_RATED");
    expect(json.feedbackId).toBe(EXISTING_FEEDBACK_ID);

    // A real on-chain rating is terminal: no insert, no update, no signing.
    expect(mockInsertReturning).not.toHaveBeenCalled();
    expect(mockUpdateWhere).not.toHaveBeenCalled();
    expect(mockSignEthereumTransaction).not.toHaveBeenCalled();
    expect(mockBroadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("reuses the existing row (no insert, status reset, same feedbackId) when prior row has NULL txHash and forceBroadcast is true", async () => {
    queueSelects([
      {
        id: EXISTING_FEEDBACK_ID,
        txHash: null,
        status: "failed",
        createdAt: EXISTING_CREATED_AT,
      },
    ]);

    const res = await callFeedback({ ...VALID_BODY, forceBroadcast: true });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      feedbackId: string;
      txHash: string;
    };
    // Same id as the stranded row -- the feedbackURI stays stable.
    expect(json.feedbackId).toBe(EXISTING_FEEDBACK_ID);
    expect(json.txHash).toBe(BROADCAST_TX_HASH);

    // Reuse path: NO insert. The first update resets status to "pending".
    expect(mockInsertReturning).not.toHaveBeenCalled();
    expect(mockUpdateWhere).toHaveBeenCalled();
    // The KEEP-515 fix: the reuse update().set(...) resets the stranded row
    // back to "pending", clears the prior error, and refreshes every
    // input-derived field. A regression that changed this transition must
    // fail here.
    expect(mockUpdateSet).toHaveBeenNthCalledWith(
      1,
      REUSE_SET_PAYLOAD_FOR_VALID_BODY
    );
    // Broadcast retried against the reused row.
    expect(mockSignEthereumTransaction).toHaveBeenCalledTimes(1);
    expect(mockBroadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("reuses a stranded NULL-txHash row even without forceBroadcast -- plain retry after a failed broadcast recovers", async () => {
    queueSelects([
      {
        id: EXISTING_FEEDBACK_ID,
        txHash: null,
        status: "failed",
        createdAt: EXISTING_CREATED_AT,
      },
    ]);

    // No forceBroadcast flag at all -- this is the literal KEEP-515 scenario.
    const res = await callFeedback(VALID_BODY);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { feedbackId: string; txHash: string };
    // Row reused, not re-inserted -- caller is NOT locked out.
    expect(json.feedbackId).toBe(EXISTING_FEEDBACK_ID);
    expect(json.txHash).toBe(BROADCAST_TX_HASH);
    expect(mockInsertReturning).not.toHaveBeenCalled();
    expect(mockUpdateWhere).toHaveBeenCalled();
    // Same reuse transition as the forceBroadcast case -- a plain retry must
    // reset the stranded row to "pending" / error null and refresh the
    // input-derived fields, no flag required.
    expect(mockUpdateSet).toHaveBeenNthCalledWith(
      1,
      REUSE_SET_PAYLOAD_FOR_VALID_BODY
    );
    expect(mockBroadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("overwrites stale value/comment/agentId on the reused row when a retry changes them -- the served JSON must match the committed hash", async () => {
    // The stranded row was created from VALID_BODY (value 5 / "great run"),
    // but the caller now retries with different content. The on-chain
    // feedbackHash is computed from THIS request, and /api/feedback/[id]
    // rebuilds the served JSON from the persisted row -- so the reuse
    // update().set(...) MUST persist the new values, or the two diverge and
    // the ERC-8004 hash verification breaks.
    queueSelects([
      {
        id: EXISTING_FEEDBACK_ID,
        txHash: null,
        status: "failed",
        createdAt: EXISTING_CREATED_AT,
      },
    ]);

    const res = await callFeedback({
      executionId: TEST_EXECUTION_ID,
      value: "1",
      valueDecimals: 2,
      comment: "actually a bad run",
      agentId: "999",
    });

    expect(res.status).toBe(200);
    expect(mockInsertReturning).not.toHaveBeenCalled();
    // The reuse .set(...) carries the NEW input, not the stranded row's
    // original VALID_BODY values.
    expect(mockUpdateSet).toHaveBeenNthCalledWith(1, {
      status: "pending",
      error: null,
      workflowId: TEST_WORKFLOW_ID,
      agentChainId: ETHEREUM_MAINNET_CHAIN_ID,
      agentId: "999",
      value: "1",
      valueDecimals: 2,
      comment: "actually a bad run",
      txChainId: ETHEREUM_MAINNET_CHAIN_ID,
    });
  });

  it("leaves the row retryable (status failed, txHash still null) and returns RPC_UPSTREAM when the broadcast fails", async () => {
    queueSelects([]); // fresh insert path
    mockBroadcastSignedTransaction.mockRejectedValueOnce(
      new Error("insufficient funds for gas")
    );

    const res = await callFeedback(VALID_BODY);

    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: string; feedbackId: string };
    expect(json.code).toBe("RPC_UPSTREAM");
    expect(json.feedbackId).toBe(NEW_FEEDBACK_ID);

    // The failure path updates the row to status "failed" and never sets a
    // txHash -- so a later call sees a NULL-txHash row and can retry. Assert
    // the recovery update().set(...) carried the exact failure payload
    // (status "failed" + the broadcast error) and that no .set() call ever
    // wrote a txHash.
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({
      status: "failed",
      error: "insufficient funds for gas",
    });
    for (const [payload] of mockUpdateSet.mock.calls) {
      expect(payload).not.toHaveProperty("txHash");
    }
    // The route never reached the success update that writes txHash.
    expect(mockBroadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/agentic-wallet/feedback -- gas preflight", () => {
  it("returns 402 INSUFFICIENT_GAS and leaves the row stranded when the wallet holds zero ETH", async () => {
    queueSelects([]); // fresh insert path
    mockGetBalance.mockResolvedValueOnce(BigInt(0));

    const res = await callFeedback(VALID_BODY);

    expect(res.status).toBe(402);
    const json = (await res.json()) as {
      code: string;
      feedbackId: string;
      balanceWei: string;
    };
    expect(json.code).toBe("INSUFFICIENT_GAS");
    expect(json.feedbackId).toBe(NEW_FEEDBACK_ID);
    expect(json.balanceWei).toBe("0");

    // The row was inserted then marked "failed" -- a stranded, retryable row
    // (KEEP-515). estimateGas is never reached; nothing is signed or cast.
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({
      status: "failed",
      error: expect.stringContaining("below any mainnet gas"),
    });
    expect(mockSignEthereumTransaction).not.toHaveBeenCalled();
    expect(mockBroadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("returns 402 INSUFFICIENT_GAS with the required amount when the balance cannot cover the estimated cost", async () => {
    queueSelects([]); // fresh insert path
    // Non-zero, so it clears the zero short-circuit, but far below the canned
    // cost: gasWithHeadroom (120_000 * 1.2) * maxFeePerGas (30 gwei).
    mockGetBalance.mockResolvedValueOnce(BigInt(1));

    const res = await callFeedback(VALID_BODY);

    expect(res.status).toBe(402);
    const json = (await res.json()) as {
      code: string;
      balanceWei: string;
      requiredWei: string;
    };
    expect(json.code).toBe("INSUFFICIENT_GAS");
    expect(json.balanceWei).toBe("1");
    expect(json.requiredWei).toBe(
      (BigInt(144_000) * BigInt(30_000_000_000)).toString()
    );
    expect(mockSignEthereumTransaction).not.toHaveBeenCalled();
    expect(mockBroadcastSignedTransaction).not.toHaveBeenCalled();
  });
});
