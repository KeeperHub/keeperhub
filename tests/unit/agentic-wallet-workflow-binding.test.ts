/**
 * Phase 37 fix #2: workflow-slug binding for /sign.
 *
 * verifyWorkflowBinding(slug, payTo, amountMicro) reads the workflows
 * registry and the active organization wallet, then verifies that the
 * caller-supplied payTo + amount match the registry-derived expected
 * values. This is the server-side gate that closes the HMAC-compromise
 * drain — without it, a stolen HMAC secret could redirect a wallet's
 * funds to any address the attacker chose.
 *
 * Strategy: hoisted vi mocks for db.select() so the test stays focused
 * on the matching logic and does not require a live Postgres. The mock
 * pulls from a single FIFO queue in call order: workflow lookup, then
 * (only when wf.chain is truthy) the chains-table lookup classifyChainTag
 * now runs, then the organizationWallets lookup. The chains query is
 * awaited directly (no .limit()), so the mock's query-result object
 * supports both `.limit()` and being awaited on its own.
 *
 * KEEP-1055: classifyChainTag was DATA_CHAIN_SLUG_TO_ID /
 * KNOWN_DATA_CHAIN_IDS -- two hardcoded shadows of the chains table that
 * never tracked chains.isEnabled. It now queries chains directly, so
 * these tests supply their own CHAINS_FIXTURE (mirroring what
 * scripts/seed/seed-chains.ts seeds in production) instead of importing
 * the old exported maps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkflowRow = {
  id: string;
  organizationId: string | null;
  priceUsdcPerCall: string | null;
  isListed: boolean;
  chain: string | null;
};

type WalletRow = {
  walletAddress: string;
};

type ChainRow = {
  chainId: number;
  aliases: string[];
  isTestnet: boolean;
  isPaymentRail: boolean;
};

const { mockSelectQueue } = vi.hoisted(
  (): { mockSelectQueue: { rows: unknown[][] } } => ({
    mockSelectQueue: { rows: [] },
  })
);

vi.mock("@/lib/db", () => {
  function nextRows(): unknown[] {
    return mockSelectQueue.rows.shift() ?? [];
  }
  function queryResult(): PromiseLike<unknown[]> & {
    limit: () => Promise<unknown[]>;
  } {
    return {
      limit: (): Promise<unknown[]> => Promise.resolve(nextRows()),
      // biome-ignore lint/suspicious/noThenProperty: the chains lookup awaits the drizzle query builder directly (no .limit()), so the mock has to be a genuine thenable to stand in for it
      then<TResult1 = unknown[], TResult2 = never>(
        onFulfilled?:
          | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onRejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve(nextRows()).then(
          onFulfilled ?? undefined,
          onRejected ?? undefined
        );
      },
    };
  }
  return {
    db: {
      select: (): {
        from: () => { where: () => ReturnType<typeof queryResult> };
      } => ({
        from: () => ({
          where: () => queryResult(),
        }),
      }),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  workflows: { _table: "workflows" },
  organizationWallets: { _table: "organization_wallets" },
  chains: { _table: "chains" },
}));

const {
  verifyWorkflowBinding,
  classifyChainTag,
  MULTI_CHAIN_TAGS,
  PAYMENT_RAIL_TAGS,
  _resetChainLookupCacheForTesting,
} = await import("@/lib/agentic-wallet/workflow-binding");

const SLUG = "test-slug";
const CREATOR = "0xCreATor000000000000000000000000000000001";
const ATTACKER = "0xAttacker0000000000000000000000000000beef";

// Mirrors scripts/seed/seed-chains.ts post-KEEP-1055: mainnets carry
// aliases, Base/Tempo are flagged as payment rails, testnets carry
// neither (so classifyChainTag treats them as unrecognised).
const CHAINS_FIXTURE: ChainRow[] = [
  {
    chainId: 1,
    aliases: ["ethereum", "eth"],
    isTestnet: false,
    isPaymentRail: false,
  },
  { chainId: 11_155_111, aliases: [], isTestnet: true, isPaymentRail: false },
  { chainId: 8453, aliases: ["base"], isTestnet: false, isPaymentRail: true },
  { chainId: 84_532, aliases: [], isTestnet: true, isPaymentRail: false },
  { chainId: 4217, aliases: ["tempo"], isTestnet: false, isPaymentRail: true },
  { chainId: 4218, aliases: ["tempo"], isTestnet: true, isPaymentRail: true },
  {
    chainId: 56,
    aliases: ["bnb", "bsc", "binance"],
    isTestnet: false,
    isPaymentRail: false,
  },
  {
    chainId: 137,
    aliases: ["polygon", "matic"],
    isTestnet: false,
    isPaymentRail: false,
  },
  {
    chainId: 42_161,
    aliases: ["arbitrum", "arbitrum-one"],
    isTestnet: false,
    isPaymentRail: false,
  },
  { chainId: 421_614, aliases: [], isTestnet: true, isPaymentRail: false },
  { chainId: 80_002, aliases: [], isTestnet: true, isPaymentRail: false },
  {
    chainId: 10,
    aliases: ["optimism", "op"],
    isTestnet: false,
    isPaymentRail: false,
  },
  {
    chainId: 43_114,
    aliases: ["avalanche", "avax"],
    isTestnet: false,
    isPaymentRail: false,
  },
  { chainId: 43_113, aliases: [], isTestnet: true, isPaymentRail: false },
  {
    chainId: 9745,
    aliases: ["plasma"],
    isTestnet: false,
    isPaymentRail: false,
  },
  { chainId: 9746, aliases: [], isTestnet: true, isPaymentRail: false },
  {
    chainId: 16_661,
    aliases: ["0g", "og", "aristotle"],
    isTestnet: false,
    isPaymentRail: false,
  },
  { chainId: 16_602, aliases: [], isTestnet: true, isPaymentRail: false },
];

// The subset classifyChainTag should classify as "data" -- enabled,
// non-testnet, non-payment-rail. Used in place of the old exported
// KNOWN_DATA_CHAIN_IDS so the test's expectation is independent of the
// implementation it is verifying.
const DATA_CHAIN_IDS = CHAINS_FIXTURE.filter(
  (c) => !(c.isTestnet || c.isPaymentRail)
).map((c) => String(c.chainId));

const TESTNET_CHAIN_IDS = CHAINS_FIXTURE.filter((c) => c.isTestnet).map((c) =>
  String(c.chainId)
);

function queueWorkflow(row: Partial<WorkflowRow> | null): void {
  // loadEnabledChains caches for 60s in-process; without a reset here, a
  // test that calls verifyWorkflowBinding more than once (e.g. looping
  // over several chain slugs) would only issue a real chains query on its
  // first call, leaving every later queued CHAINS_FIXTURE unconsumed and
  // shifting the FIFO out of sync with the next wallet-row queue entry.
  _resetChainLookupCacheForTesting();
  if (row === null) {
    mockSelectQueue.rows.push([]);
    return;
  }
  const full: WorkflowRow = {
    id: "wf_test",
    organizationId: "org_test",
    priceUsdcPerCall: "0.05",
    isListed: true,
    chain: null,
    ...row,
  };
  mockSelectQueue.rows.push([full]);
  // classifyChainTag only queries chains when wf.chain is truthy AND is
  // neither an explicit multi-chain tag nor a payment-rail tag -- both
  // short-circuit before the DB query runs.
  const normalised = full.chain?.trim().toLowerCase();
  const isShortCircuitTag = Boolean(
    normalised &&
      (MULTI_CHAIN_TAGS.has(normalised) || PAYMENT_RAIL_TAGS.has(normalised))
  );
  if (full.chain && !isShortCircuitTag) {
    mockSelectQueue.rows.push(CHAINS_FIXTURE);
  }
}

function queueWallet(row: Partial<WalletRow> | null): void {
  if (row === null) {
    mockSelectQueue.rows.push([]);
    return;
  }
  const full: WalletRow = { walletAddress: CREATOR, ...row };
  mockSelectQueue.rows.push([full]);
}

describe("verifyWorkflowBinding", () => {
  beforeEach(() => {
    mockSelectQueue.rows = [];
    _resetChainLookupCacheForTesting();
  });

  it("returns ok when slug + payTo + amount all match", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedPayTo).toBe(CREATOR);
      expect(r.expectedAmountMicro).toBe("50000");
      expect(r.workflowId).toBe("wf_test");
    }
  });

  it("returns 403 PAYTO_MISMATCH when payTo differs from registry", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", ATTACKER, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "PAYTO_MISMATCH",
    });
  });

  it("returns 403 AMOUNT_MISMATCH when amount differs from priceUsdcPerCall", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "100000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "AMOUNT_MISMATCH",
    });
  });

  it("returns 403 UNKNOWN_WORKFLOW for an unknown slug", async () => {
    queueWorkflow(null);
    const r = await verifyWorkflowBinding("nope", "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
    });
  });

  it("returns 403 WORKFLOW_NOT_PAYABLE when workflow has no active org wallet", async () => {
    queueWorkflow({});
    queueWallet(null);
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "WORKFLOW_NOT_PAYABLE",
    });
  });

  it("compares addresses case-insensitively", async () => {
    queueWorkflow({});
    queueWallet({ walletAddress: CREATOR.toUpperCase() });
    const r = await verifyWorkflowBinding(
      SLUG,
      "base",
      CREATOR.toLowerCase(),
      "50000"
    );
    expect(r.ok).toBe(true);
  });

  it("returns 400 WORKFLOW_SLUG_REQUIRED when slug is empty", async () => {
    const r = await verifyWorkflowBinding("", "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: "WORKFLOW_SLUG_REQUIRED",
    });
  });

  it("returns 403 UNKNOWN_WORKFLOW when slug exists but isListed=false", async () => {
    // The SQL `where` filters on isListed=true at the DB level, so an
    // unlisted row never reaches the code. Simulate by queueing an empty
    // result for the workflow lookup.
    queueWorkflow(null);
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
    });
  });

  // Fix-pack-2 R2: tempo MPP proofs don't carry payTo/amount in their
  // typed-data (only chainId + challengeId). The binding lookup still runs to
  // resolve the workflow's price for the R1 daily-spend deduction, but the
  // caller-side payTo/amount equality checks MUST be skipped — otherwise
  // every priced tempo workflow 403s on PAYTO_MISMATCH.
  it("tempo: returns ok with empty payTo + amount (skips equality checks)", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedAmountMicro).toBe("50000");
      expect(r.expectedPayTo).toBe(CREATOR);
    }
  });

  it("tempo: still returns UNKNOWN_WORKFLOW for an unknown slug", async () => {
    queueWorkflow(null);
    const r = await verifyWorkflowBinding("nope", "tempo", "", "0");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
    });
  });

  // Fix-pack-3 N-1: the caller-supplied chain must match the workflow's
  // registered chain. Without this, an attacker with a compromised HMAC
  // secret could claim chain="tempo" on a Base-registered workflow to bypass
  // the Base-side payTo/amount equality checks and mint an MPP proof
  // against a dual-chain victim's tempo wallet.
  it("returns 403 CHAIN_MISMATCH when caller chain differs from workflow chain", async () => {
    queueWorkflow({ chain: "base" });
    const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "CHAIN_MISMATCH",
    });
  });

  it("accepts a request when caller chain matches the workflow chain", async () => {
    queueWorkflow({ chain: "tempo" });
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
    expect(r.ok).toBe(true);
  });

  it("is permissive when workflow.chain is null (legacy listings)", async () => {
    queueWorkflow({ chain: null });
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r.ok).toBe(true);
  });

  // KEEP-391 (Fix-pack-4): the chain match must be performed on a normalised
  // tag so listings stored with a numeric chain id are interoperable with
  // the wallet's slug-form payload. Before this fix, a workflow listed with
  // chain="8453" rejected every legitimate Base x402 payment because the
  // wallet client always sends chain="base".
  describe("chain tag normalisation (KEEP-391)", () => {
    it("accepts caller chain=base when workflow.chain is the Base chain id 8453", async () => {
      queueWorkflow({ chain: "8453" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r.ok).toBe(true);
    });

    it("accepts caller chain=tempo when workflow.chain is Tempo mainnet id 4217", async () => {
      queueWorkflow({ chain: "4217" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r.ok).toBe(true);
    });

    it("accepts caller chain=tempo when workflow.chain is Tempo testnet id 4218", async () => {
      queueWorkflow({ chain: "4218" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r.ok).toBe(true);
    });

    it("normalises case + whitespace on slug input (Base, ' tempo ')", async () => {
      queueWorkflow({ chain: "Base" });
      queueWallet({});
      const r1 = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r1.ok).toBe(true);

      queueWorkflow({ chain: " tempo " });
      queueWallet({});
      const r2 = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r2.ok).toBe(true);
    });

    it("still rejects when normalised wf.chain differs from caller (Base id vs tempo caller)", async () => {
      queueWorkflow({ chain: "8453" });
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });

    // chain: "ethereum" resolves as a data-chain slug (not payment-chain rejection).
    // "9999" remains the unrecognised-chain case in the test below.
    it("accepts data-chain slug aliases (ethereum, polygon, arbitrum, bsc)", async () => {
      for (const chainSlug of [
        "ethereum",
        "polygon",
        "arbitrum",
        "bsc",
      ] as const) {
        queueWorkflow({ chain: chainSlug });
        queueWallet({});
        const rBase = await verifyWorkflowBinding(
          SLUG,
          "base",
          CREATOR,
          "50000"
        );
        expect(rBase.ok).toBe(true);

        queueWorkflow({ chain: chainSlug });
        queueWallet({});
        const rTempo = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
        expect(rTempo.ok).toBe(true);
      }
    });

    it("rejects an unrecognised wf.chain tag (defensive — no silent widening)", async () => {
      // Unknown slug that is not in the chains fixture at all.
      queueWorkflow({ chain: "9999" });
      const rBase = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(rBase).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });

      queueWorkflow({ chain: "9999" });
      const rTempo = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(rTempo).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });

    it("rejects a disabled chain even though it is otherwise a known data chain", async () => {
      // classifyChainTag's chains query already filters isEnabled=true at
      // the SQL level, so a disabled chain never appears in the fixture the
      // query returns -- simulate by queueing a fixture with chainId 1 (the
      // Ethereum row from the accepted-alias test above) absent.
      queueWorkflow({ chain: "1" });
      mockSelectQueue.rows[1] = CHAINS_FIXTURE.filter((c) => c.chainId !== 1);
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });
  });

  // KEEP-432 (Fix-pack-5): listings whose chain identifies a data chain
  // (Ethereum, Optimism, Polygon, Arbitrum) have no inherent payment-chain
  // preference. Either Base x402 or Tempo MPP must be accepted, otherwise
  // priced cross-chain-data workflows are unreachable from the wallet.
  describe("data-chain listings (KEEP-432)", () => {
    it("accepts Base payment for an Ethereum-data listing (chain=1)", async () => {
      queueWorkflow({ chain: "1" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r.ok).toBe(true);
    });

    it("accepts Tempo payment for an Ethereum-data listing (chain=1)", async () => {
      queueWorkflow({ chain: "1" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r.ok).toBe(true);
    });

    it("accepts either payment chain for every data chain in the chains table", async () => {
      // Sourced from CHAINS_FIXTURE (which mirrors seed-chains.ts) instead
      // of an implementation-owned constant, so this stays a check on
      // classifyChainTag's behavior rather than a tautology against its
      // own data. Skip "1" because it's covered by the explicit Ethereum
      // tests above.
      for (const dataChain of DATA_CHAIN_IDS) {
        if (dataChain === "1") {
          continue;
        }

        queueWorkflow({ chain: dataChain });
        queueWallet({});
        const rBase = await verifyWorkflowBinding(
          SLUG,
          "base",
          CREATOR,
          "50000"
        );
        expect(rBase.ok).toBe(true);

        queueWorkflow({ chain: dataChain });
        queueWallet({});
        const rTempo = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
        expect(rTempo.ok).toBe(true);
      }
    });

    it("still enforces payTo equality on the Base path for a data-chain listing", async () => {
      queueWorkflow({ chain: "1" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", ATTACKER, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "PAYTO_MISMATCH",
      });
    });

    it("still enforces amount equality on the Base path for a data-chain listing", async () => {
      queueWorkflow({ chain: "1" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "100000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "AMOUNT_MISMATCH",
      });
    });

    it("rejects non-integer amount on Base for a data-chain listing", async () => {
      queueWorkflow({ chain: "1" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "abc");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "AMOUNT_MISMATCH",
      });
    });

    it("compares payTo case-insensitively on a data-chain listing", async () => {
      queueWorkflow({ chain: "1" });
      queueWallet({ walletAddress: CREATOR.toUpperCase() });
      const r = await verifyWorkflowBinding(
        SLUG,
        "base",
        CREATOR.toLowerCase(),
        "50000"
      );
      expect(r.ok).toBe(true);
    });

    it("returns 403 WORKFLOW_NOT_PAYABLE for a data-chain listing without an active wallet", async () => {
      queueWorkflow({ chain: "1" });
      queueWallet(null);
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "WORKFLOW_NOT_PAYABLE",
      });
    });
  });

  // Explicit multi-chain tags ("multi-chain", "any", ...) declare no single
  // payment-chain preference, so both Base x402 and Tempo MPP are accepted --
  // the same acceptance as a data-chain id. Before this, a listing tagged
  // "multi-chain" fell through to the defensive-mismatch branch and 403'd
  // every payment on both rails.
  describe("multi-chain listings", () => {
    it("accepts Base payment for a multi-chain listing", async () => {
      queueWorkflow({ chain: "multi-chain" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r.ok).toBe(true);
    });

    it("accepts Tempo payment for a multi-chain listing", async () => {
      queueWorkflow({ chain: "multi-chain" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r.ok).toBe(true);
    });

    it("accepts either payment chain for every multi-chain tag", async () => {
      // MULTI_CHAIN_TAGS is checked before the chains-table lookup, so no
      // chains fixture needs queueing for these.
      for (const tag of MULTI_CHAIN_TAGS) {
        queueWorkflow({ chain: tag });
        queueWallet({});
        const rBase = await verifyWorkflowBinding(
          SLUG,
          "base",
          CREATOR,
          "50000"
        );
        expect(rBase.ok).toBe(true);

        queueWorkflow({ chain: tag });
        queueWallet({});
        const rTempo = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
        expect(rTempo.ok).toBe(true);
      }
    });

    it("normalises case + whitespace on a multi-chain tag", async () => {
      queueWorkflow({ chain: " Multi-Chain " });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r.ok).toBe(true);
    });

    it("still enforces payTo equality on the Base path for a multi-chain listing", async () => {
      queueWorkflow({ chain: "multi-chain" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", ATTACKER, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "PAYTO_MISMATCH",
      });
    });

    it("still enforces amount equality on the Base path for a multi-chain listing", async () => {
      queueWorkflow({ chain: "multi-chain" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "100000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "AMOUNT_MISMATCH",
      });
    });
  });

  // KEEP-432 negative-set integrity: lock in the strict-decimal classifier
  // semantics so a future producer change (hex serialisation, leading-zero
  // normalisation, etc.) can't silently break existing listings or widen
  // acceptance to a chain that was meant to reject.
  describe("classifier strictness (KEEP-432 negative set)", () => {
    it("rejects whitespace-only wf.chain as unrecognised", async () => {
      // " " is truthy so reaches classifyChainTag, then trims to "" which
      // doesn't match any known tag.
      queueWorkflow({ chain: "   " });
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });

    it("rejects leading-zero numeric ids ('08453', '01')", async () => {
      queueWorkflow({ chain: "08453" });
      const r1 = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r1).toMatchObject({ ok: false, code: "CHAIN_MISMATCH" });

      queueWorkflow({ chain: "01" });
      const r2 = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r2).toMatchObject({ ok: false, code: "CHAIN_MISMATCH" });
    });

    it("rejects 0x-prefixed hex chain ids", async () => {
      queueWorkflow({ chain: "0x1" });
      const r1 = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r1).toMatchObject({ ok: false, code: "CHAIN_MISMATCH" });

      queueWorkflow({ chain: "0x2105" }); // 8453 in hex
      const r2 = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r2).toMatchObject({ ok: false, code: "CHAIN_MISMATCH" });
    });

    it("rejects float / decimal chain forms ('8453.0')", async () => {
      queueWorkflow({ chain: "8453.0" });
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r).toMatchObject({ ok: false, code: "CHAIN_MISMATCH" });
    });

    it("rejects testnet ids even though they exist (enabled) in the chains table", async () => {
      // Mainnet-only by intent, now enforced via chains.isTestnet rather
      // than a curated id set. If KeeperHub starts supporting testnet
      // listings, flip isTestnet on the relevant seed row and update this
      // test.
      for (const t of TESTNET_CHAIN_IDS) {
        queueWorkflow({ chain: t });
        const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
        expect(r).toMatchObject({ ok: false, code: "CHAIN_MISMATCH" });
      }
    });
  });

  // KEEP-432 symmetric cross-chain-proof tests: the original Fix-pack-3 N-1
  // defence is bidirectional. The KEEP-391 test suite covers Base-pinned +
  // tempo-caller; these cover the inverse so a future code change that
  // flips the equality direction is caught.
  describe("payment-chain pin is symmetric (KEEP-432)", () => {
    it("rejects tempo-pinned listing with base caller", async () => {
      queueWorkflow({ chain: "tempo" });
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });

    it("rejects Tempo-mainnet-id listing with base caller", async () => {
      queueWorkflow({ chain: "4217" });
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });

    it("rejects Tempo-testnet-id listing with base caller", async () => {
      queueWorkflow({ chain: "4218" });
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });
  });

  // The two payment rails resolve from code, so no arrangement of chain rows
  // (or absence of them) can turn a rail tag into a defensive 403.
  describe("payment-rail tags do not depend on chain rows", () => {
    it("classifies chain=tempo without querying chains at all", async () => {
      // Regression: seed-chains.ts stamps aliases ["tempo"] + isPaymentRail on
      // the Tempo TESTNET row, whose seeded chainId (42431) is not one the
      // wallet routes (4218). Resolving the alias against an unordered chains
      // query matched that row first and collapsed "tempo" to unrecognised,
      // 403ing every Tempo MPP payment. Only two queries may run here -- the
      // workflow row and the wallet row -- so a fully drained queue is the
      // assertion that no chains lookup happened.
      mockSelectQueue.rows.push([
        {
          id: "wf_test",
          organizationId: "org_test",
          priceUsdcPerCall: "0.05",
          isListed: true,
          chain: "tempo",
        },
      ]);
      mockSelectQueue.rows.push([{ walletAddress: CREATOR }]);

      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");

      expect(r.ok).toBe(true);
      expect(mockSelectQueue.rows).toHaveLength(0);
    });

    it("classifies chain=base in an environment with no chains rows", async () => {
      // An unseeded PR-environment DB, or one bootstrapped by db:migrate
      // alone, returns zero enabled rows. Before this, that made even "base"
      // unrecognised and 403'd every priced listing in the environment.
      mockSelectQueue.rows.push([
        {
          id: "wf_test",
          organizationId: "org_test",
          priceUsdcPerCall: "0.05",
          isListed: true,
          chain: "base",
        },
      ]);
      mockSelectQueue.rows.push([{ walletAddress: CREATOR }]);

      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");

      expect(r.ok).toBe(true);
      expect(mockSelectQueue.rows).toHaveLength(0);
    });
  });
});

describe("classifyChainTag chain-row cache", () => {
  beforeEach(() => {
    mockSelectQueue.rows = [];
    _resetChainLookupCacheForTesting();
  });

  it("does not cache an empty result", async () => {
    // seed-chains.ts disables stale rows as part of a run, so the table can
    // briefly answer with nothing. Caching that kept every data-chain tag
    // unrecognised -- 403 on payment, 422 on publish -- for a full TTL after
    // the table was already correct again.
    mockSelectQueue.rows.push([]);
    expect(await classifyChainTag("1")).toEqual({ kind: "unrecognised" });

    mockSelectQueue.rows.push(CHAINS_FIXTURE);
    expect(await classifyChainTag("1")).toEqual({ kind: "data" });
  });

  it("caches a non-empty result", async () => {
    mockSelectQueue.rows.push(CHAINS_FIXTURE);
    expect(await classifyChainTag("1")).toEqual({ kind: "data" });

    // No second fixture queued: a cache miss would read an empty queue and
    // classify the same tag as unrecognised.
    expect(await classifyChainTag("137")).toEqual({ kind: "data" });
  });
});
