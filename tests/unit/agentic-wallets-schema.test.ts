import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type AgenticWallet,
  type AgenticWalletCredit,
  approvalRiskLevel,
  approvalStatus,
  type NewAgenticWallet,
  type NewAgenticWalletCredit,
  type NewWalletApprovalRequest,
  agenticWalletCredits as reexportedAgenticWalletCredits,
  agenticWallets as reexportedAgenticWallets,
  walletApprovalRequests as reexportedApprovalRequests,
  type WalletApprovalRequest,
} from "../../lib/db/schema";
import { agenticWalletCredits } from "../../lib/db/schema-agentic-wallet-credits";
import {
  agenticWallets,
  walletApprovalRequests,
} from "../../lib/db/schema-agentic-wallets";

// ONBOARD-06 invariant: agentic_wallets has NO expires_at column.
// Wave 0 RED: this test fails until lib/db/schema-agentic-wallets.ts lands (Task 2)
// and the re-export block is wired into lib/db/schema.ts (Task 3). The final GREEN
// state passes all three describe blocks.

describe("agenticWallets table: v1.8 schema", () => {
  const cfg = getTableConfig(agenticWallets);

  it("has required columns", () => {
    const cols = new Set(cfg.columns.map((c) => c.name));
    const required = [
      "id",
      "sub_org_id",
      "wallet_address_base",
      "wallet_address_tempo",
      "hmac_secret",
      "linked_user_id",
      "linked_at",
      "created_at",
    ];
    for (const name of required) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("hmac_secret is nullable at schema level (REVIEW CR-01 relaxed to avoid migration break)", () => {
    const col = cfg.columns.find((c) => c.name === "hmac_secret");
    expect(col).toBeDefined();
    // Runtime invariant: provisionAgenticWallet always writes a non-null
    // 64-hex secret for new rows; lookupHmacSecret treats null as unknown
    // sub-org. Schema-level NOT NULL was dropped because Phase 32 shipped
    // rows without a secret and an ADD COLUMN ... NOT NULL with no DEFAULT
    // would break the staging/prod deploy.
    expect(col?.notNull).toBe(false);
  });

  it("has NO expires_at column (ONBOARD-06: permanent)", () => {
    const cols = new Set(cfg.columns.map((c) => c.name));
    expect(cols.has("expires_at")).toBe(false);
  });

  it("id column is primary key", () => {
    const col = cfg.columns.find((c) => c.name === "id");
    expect(col).toBeDefined();
    expect(col?.primary).toBe(true);
  });

  it("sub_org_id is unique and notNull", () => {
    const col = cfg.columns.find((c) => c.name === "sub_org_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.isUnique).toBe(true);
  });

  it("linked_user_id is nullable", () => {
    const col = cfg.columns.find((c) => c.name === "linked_user_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });

  it("created_at has default", () => {
    const col = cfg.columns.find((c) => c.name === "created_at");
    expect(col).toBeDefined();
    expect(col?.hasDefault).toBe(true);
  });

  it("linked_user_id FK uses ON DELETE SET NULL (ONBOARD-06 audit trail)", () => {
    const fk = cfg.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "linked_user_id")
    );
    expect(fk).toBeDefined();
    expect(fk?.onDelete).toBe("set null");
  });
});

describe("walletApprovalRequests table: v1.8 schema", () => {
  const cfg = getTableConfig(walletApprovalRequests);

  it("has required columns", () => {
    const cols = new Set(cfg.columns.map((c) => c.name));
    const required = [
      "id",
      "sub_org_id",
      "operation_payload",
      "status",
      "risk_level",
      "created_at",
      "resolved_at",
      "resolved_by_user_id",
    ];
    for (const name of required) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("status defaults to pending", () => {
    const col = cfg.columns.find((c) => c.name === "status");
    expect(col).toBeDefined();
    expect(col?.hasDefault).toBe(true);
  });

  it("risk_level is notNull with no default", () => {
    const col = cfg.columns.find((c) => c.name === "risk_level");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.hasDefault).toBe(false);
  });

  it("operation_payload is notNull", () => {
    const col = cfg.columns.find((c) => c.name === "operation_payload");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
  });

  it("resolved_by_user_id is nullable", () => {
    const col = cfg.columns.find((c) => c.name === "resolved_by_user_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });

  it("sub_org_id FK uses ON DELETE CASCADE (approval rows die with wallet)", () => {
    const fk = cfg.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "sub_org_id")
    );
    expect(fk).toBeDefined();
    expect(fk?.onDelete).toBe("cascade");
  });

  it("resolved_by_user_id FK uses ON DELETE SET NULL (audit preservation)", () => {
    const fk = cfg.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "resolved_by_user_id")
    );
    expect(fk).toBeDefined();
    expect(fk?.onDelete).toBe("set null");
  });
});

describe("agenticWalletCredits table", () => {
  const cfg = getTableConfig(agenticWalletCredits);

  it("has required columns", () => {
    const cols = new Set(cfg.columns.map((c) => c.name));
    const required = [
      "id",
      "sub_org_id",
      "amount_usdc_cents",
      "allocation_reason",
      "granted_at",
    ];
    for (const name of required) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("id column is primary key", () => {
    const col = cfg.columns.find((c) => c.name === "id");
    expect(col).toBeDefined();
    expect(col?.primary).toBe(true);
  });

  it("sub_org_id FK uses ON DELETE CASCADE (credits die with wallet)", () => {
    const fk = cfg.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "sub_org_id")
    );
    expect(fk).toBeDefined();
    expect(fk?.onDelete).toBe("cascade");
  });

  it("allocation_reason defaults to 'onboard_initial'", () => {
    const col = cfg.columns.find((c) => c.name === "allocation_reason");
    expect(col).toBeDefined();
    expect(col?.hasDefault).toBe(true);
    expect(col?.notNull).toBe(true);
  });

  it("amount_usdc_cents is notNull (integer column)", () => {
    const col = cfg.columns.find((c) => c.name === "amount_usdc_cents");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
  });

  it("granted_at is notNull and has default (now())", () => {
    const col = cfg.columns.find((c) => c.name === "granted_at");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.hasDefault).toBe(true);
  });

  it("has UNIQUE index on (sub_org_id, allocation_reason) — T-33-07 guard", () => {
    const unique = cfg.indexes.find(
      (idx) => idx.config.name === "uq_agentic_wallet_credits_sub_org_reason"
    );
    expect(unique).toBeDefined();
    expect(unique?.config.unique).toBe(true);
    const columns = unique?.config.columns ?? [];
    const names = columns.map((c: any) => c.name);
    expect(names).toContain("sub_org_id");
    expect(names).toContain("allocation_reason");
  });

  it("has idx_agentic_wallet_credits_sub_org non-unique index", () => {
    const nonUnique = cfg.indexes.find(
      (idx) => idx.config.name === "idx_agentic_wallet_credits_sub_org"
    );
    expect(nonUnique).toBeDefined();
    expect(nonUnique?.config.unique).toBeFalsy();
  });
});

describe("re-export: @/lib/db/schema exposes agentic-wallet tables", () => {
  it("re-exports agenticWallets as the same table object", () => {
    expect(reexportedAgenticWallets).toBe(agenticWallets);
  });

  it("re-exports walletApprovalRequests as the same table object", () => {
    expect(reexportedApprovalRequests).toBe(walletApprovalRequests);
  });

  it("re-exports agenticWalletCredits as the same table object", () => {
    expect(reexportedAgenticWalletCredits).toBe(agenticWalletCredits);
  });

  it("re-exports approvalStatus pgEnum", () => {
    expect(approvalStatus).toBeDefined();
  });

  it("re-exports approvalRiskLevel pgEnum", () => {
    expect(approvalRiskLevel).toBeDefined();
  });

  it("re-exports all six types (compile-time check)", () => {
    const a: AgenticWallet | undefined = undefined;
    const b: NewAgenticWallet | undefined = undefined;
    const c: WalletApprovalRequest | undefined = undefined;
    const d: NewWalletApprovalRequest | undefined = undefined;
    const e: AgenticWalletCredit | undefined = undefined;
    const f: NewAgenticWalletCredit | undefined = undefined;
    expect([a, b, c, d, e, f]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
