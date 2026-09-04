import { describe, expect, it } from "vitest";
import { POLICY_SCHEMA_VERSION, parseArn } from "@/lib/policy";
import {
  draftManagedScopes,
  fromStatement,
  type StatementDraft,
  StatementTarget,
  toStatement,
} from "@/lib/policy/catalog";
import { compilePolicy } from "@/lib/policy/compile";
import type { PolicyDocument } from "@/lib/policy/types";

const POOL = "0xA238dd80C259a72e81d7e4664a9801593F98d1c5";

/**
 * Every state a rule passes through while it is being built, not only the
 * finished one. Switching to the text view and back has to keep each of them:
 * an unfinished rule that the round trip drops looks to the author like the
 * builder threw their work away, because it did.
 */
const DRAFTS: Record<string, StatementDraft> = {
  "a rule with nothing chosen yet": {
    sid: "rule-1",
    effect: "allow",
    target: StatementTarget.ONCHAIN,
    chainId: null,
    address: "",
    selectors: [],
    entries: [],
  },
  "a chain chosen, no contract": {
    sid: "rule-1",
    effect: "allow",
    target: StatementTarget.ONCHAIN,
    chainId: 8453,
    address: "",
    selectors: [],
    entries: [],
    actorRoles: ["owner"],
  },
  "a contract chosen, no function": {
    sid: "rule-1",
    effect: "allow",
    target: StatementTarget.ONCHAIN,
    chainId: 8453,
    address: POOL,
    selectors: [],
    entries: [],
  },
  "a finished onchain rule": {
    sid: "rule-1",
    effect: "allow",
    target: StatementTarget.ONCHAIN,
    chainId: 8453,
    address: POOL,
    selectors: ["0x617ba037"],
    entries: [],
    actorIds: ["seed-user-ada"],
    condition: { usdValue: { lte: "25000" } },
    limit: [
      { metric: "usd", window: "1d", max: "100000", scope: "organization" },
    ],
  },
  "a wallet rule": {
    sid: "rule-1",
    effect: "deny",
    target: StatementTarget.WALLET,
    controlCapabilities: ["wallet.role.update"],
    controlResourceId: "",
    chainId: null,
    address: "",
    selectors: [],
    entries: [],
  },
  "a member rule naming one person": {
    sid: "rule-1",
    effect: "deny",
    target: StatementTarget.MEMBER,
    controlCapabilities: ["member.remove"],
    controlResourceId: "seed-user-cleo",
    chainId: null,
    address: "",
    selectors: [],
    entries: [],
    actorRoles: ["owner"],
  },
  "a workflow rule scoped to a project": {
    sid: "rule-1",
    effect: "allow",
    target: StatementTarget.WORKFLOW,
    controlCapabilities: ["workflow.create"],
    controlResourceId: "",
    projectIds: ["proj_x"],
    chainId: null,
    address: "",
    selectors: [],
    entries: [],
  },
  "an offchain rule": {
    sid: "rule-1",
    effect: "deny",
    target: StatementTarget.OFFCHAIN,
    controlCapabilities: ["offchain.http"],
    chainId: null,
    address: "",
    selectors: [],
    entries: [],
  },
};

/** What the text view does to a document: serialise it and read it back. */
function throughText<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe.each(Object.entries(DRAFTS))("%s", (_name, draft) => {
  const statement = toStatement(draft);
  const manages = draftManagedScopes([draft]);

  it("survives the trip to the text view and back", () => {
    const parsed = fromStatement(throughText(statement));
    expect(parsed).not.toBeNull();
    if (!parsed) {
      return;
    }
    expect(parsed.chainId).toBe(draft.chainId ?? null);
    expect(parsed.address.toLowerCase()).toBe(draft.address.toLowerCase());
    expect(parsed.selectors).toHaveLength(draft.selectors.length);
    expect(parsed.actorRoles).toEqual(draft.actorRoles ?? []);
    expect(parsed.actorIds).toEqual(draft.actorIds ?? []);
    expect(parsed.projectIds).toEqual(draft.projectIds ?? []);
    expect(parsed.controlResourceId).toBe(draft.controlResourceId ?? "");
    expect(parsed.maxUsd).toBe(draft.condition?.usdValue?.lte ?? "");
    expect(parsed.dailyUsd).toBe(draft.limit?.[0]?.max ?? "");
  });

  it("emits identifiers the grammar accepts", () => {
    for (const resource of statement.resource ?? []) {
      expect(parseArn(resource).ok, resource).toBe(true);
    }
    for (const scope of manages.filter((m) => m.startsWith("kh:"))) {
      // A scope that does not parse is neither a resource nor a capability, so
      // the whole policy is refused when it is saved.
      expect(parseArn(scope).ok, scope).toBe(true);
    }
  });

  it("produces a document that compiles", () => {
    if (manages.length === 0) {
      return;
    }
    const document = {
      schemaVersion: POLICY_SCHEMA_VERSION,
      name: "Draft policy",
      enforcement: "monitor",
      acknowledgeSelfReferential: true,
      manages,
      statements: [statement],
    } as unknown as PolicyDocument;

    const compiled = compilePolicy({
      id: "p",
      enabled: true,
      document,
      enforcement: "monitor",
    });
    expect(
      compiled.ok ? null : compiled.errors.map((e) => e.message).join("; ")
    ).toBeNull();
  });
});
