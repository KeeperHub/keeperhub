import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { PROTOCOL_READ_ACTION_TYPES } from "@/lib/workflow/executor/protocol-read-actions";
import {
  CORE_READ_ONLY_STEP_TYPES,
  isOtherWorkStep,
  READ_ONLY_STEP_TYPES,
} from "@/lib/workflow/executor/step-signals";

// Each core read-only type and the name the docs Billing paragraph gives it.
const DOCS_NAMES: Readonly<Record<string, string>> = {
  trigger: "the trigger",
  Condition: "Condition",
  "State Get": "State Get",
  "web3/read-contract": "Read Contract",
  "Read Contract": "Read Contract",
  "web3/check-balance": "Get Native Token Balance",
  "Check Balance": "Get Native Token Balance",
  "web3/check-token-balance": "Get ERC20 Token Balance",
  "web3/check-allowance": "Check ERC20 Allowance",
  "web3/get-nonce": "Get Address Nonce",
  "web3/get-transaction": "Get Transaction",
  "web3/get-spl-token-balance": "Get SPL Token Balance",
  "web3/read-solana-account": "Read Solana Account",
  "web3/read-solana-program-anchor": "Read Solana Program (Anchor)",
};

// Reads through platform services (block explorer key, signature lookup, block-range scans): billed.
const PLATFORM_QUERY_STEPS: Readonly<Record<string, string>> = {
  "web3/query-events": "Query Contract Events",
  "web3/query-transactions": "Query Transaction History",
  "web3/query-solana-program-events": "Query Solana Program Events",
  "web3/decode-calldata": "Decode Calldata",
};

// Steps that can fan out into many reads: billed.
const FAN_OUT_STEPS: Readonly<Record<string, string>> = {
  "For Each": "For Each",
  Collect: "Collect",
  "web3/batch-read-contract": "Batch Read Contract",
};

const ACTION_TYPE_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

function registryReadTypes(): string[] {
  return getRegisteredProtocols()
    .flatMap((def) =>
      def.actions
        .filter((action) => action.type === "read")
        .map((action) => `${def.slug}/${action.slug}`)
    )
    .sort();
}

function billingParagraph(): string {
  const docs = readFileSync(
    join(process.cwd(), "docs", "plugins", "web3.md"),
    "utf-8"
  );
  const line = docs.split("\n").find((text) => text.startsWith("**Billing.**"));
  if (!line) {
    throw new Error("docs/plugins/web3.md has no Billing paragraph");
  }
  return line;
}

// The uncounted steps the paragraph lists, one item each, before "Any other step".
function billingListItems(paragraph: string): string[] {
  const start = "keep a waiting run uncounted:";
  const from = paragraph.indexOf(start);
  const to = paragraph.indexOf("Any other step");
  if (from === -1 || to === -1) {
    throw new Error("the Billing paragraph lost its list markers");
  }
  return paragraph
    .slice(from + start.length, to)
    .split(/[;,]| and /)
    .map((item) => item.trim().replace(/^and /, "").replace(/\.$/, ""))
    .filter((item) => item !== "");
}

describe("the read-only step list", () => {
  it("holds every protocol action the registry marks as a read, and only those (run pnpm discover-plugins)", () => {
    const reads = registryReadTypes();
    expect(reads.length).toBeGreaterThan(0);
    expect([...PROTOCOL_READ_ACTION_TYPES]).toEqual(reads);
    for (const type of reads) {
      expect(READ_ONLY_STEP_TYPES).toContain(type);
    }
  });

  it("has an inline ABI for every protocol read's contract, so a read never fetches one through the platform's explorer key", () => {
    const missing = getRegisteredProtocols().flatMap((def) =>
      def.actions
        .filter(
          (action) =>
            action.type === "read" && !def.contracts[action.contract]?.abi
        )
        .map((action) => `${def.slug}/${action.slug}`)
    );
    expect(missing).toEqual([]);
  });

  it("holds only plain slug/slug action types", () => {
    for (const type of PROTOCOL_READ_ACTION_TYPES) {
      expect(type).toMatch(ACTION_TYPE_RE);
    }
  });

  it("treats a protocol read as a read and a protocol write as work", () => {
    const write = getRegisteredProtocols()
      .flatMap((def) =>
        def.actions
          .filter((action) => action.type === "write")
          .map((action) => `${def.slug}/${action.slug}`)
      )
      .at(0);
    expect(write).toBeDefined();
    expect(READ_ONLY_STEP_TYPES).not.toContain(write);
    expect(isOtherWorkStep(write as string, { success: true })).toBe(true);
    expect(
      isOtherWorkStep(registryReadTypes()[0], { success: true, result: "1" })
    ).toBe(false);
  });

  it("counts the steps that use platform services or fan out as work", () => {
    for (const type of [
      ...Object.keys(PLATFORM_QUERY_STEPS),
      ...Object.keys(FAN_OUT_STEPS),
    ]) {
      expect(READ_ONLY_STEP_TYPES).not.toContain(type);
      expect(isOtherWorkStep(type, { success: true, events: [] })).toBe(true);
    }
  });

  it("is named in full in the docs Billing list, item by item", () => {
    expect(Object.keys(DOCS_NAMES).sort()).toEqual(
      [...CORE_READ_ONLY_STEP_TYPES].sort()
    );
    const items = billingListItems(billingParagraph());
    expect(items.sort()).toEqual(
      [
        ...new Set(Object.values(DOCS_NAMES)),
        "the waiting bundle step",
        "every protocol action that only reads (such as Aave V3: Get User Account Data)",
      ].sort()
    );
  });

  it("names the platform and fan-out steps after the list, as steps that make the run count", () => {
    const paragraph = billingParagraph();
    const after = paragraph.slice(paragraph.indexOf("Any other step"));
    expect(after).toContain("because they use platform services");
    expect(after).toContain("because they can do many reads");
    for (const name of [
      ...Object.values(PLATFORM_QUERY_STEPS),
      ...Object.values(FAN_OUT_STEPS),
    ]) {
      expect(after).toMatch(new RegExp(`\\b${name}\\b`));
      expect(billingListItems(paragraph)).not.toContain(name);
    }
  });
});
