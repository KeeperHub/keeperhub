import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import {
  evaluateConditionExpression,
  identifyLoopBody,
  resolveBodyConditionTargets,
} from "@/lib/workflow/executor/executor.workflow";

type TestNode = {
  id: string;
  data: {
    label: string;
    type: "trigger" | "action" | "add";
    config?: Record<string, unknown>;
  };
  position: { x: number; y: number };
};

type TestEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

let edgeCounter = 0;

function te(source: string, target: string, sourceHandle?: string): TestEdge {
  edgeCounter++;
  return {
    id: `e-${edgeCounter}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  };
}

function action(id: string, actionType?: string): TestNode {
  return {
    id,
    data: {
      label: id,
      type: "action",
      config: actionType ? { actionType } : undefined,
    },
    position: { x: 0, y: 0 },
  };
}

function condition(id: string): TestNode {
  return action(id, "Condition");
}

const FE_ID = "for-each";
const COLLECT_ID = "collect";

const nodes: TestNode[] = [
  action(FE_ID, "For Each"),
  action(COLLECT_ID, "Collect"),
  action("read-tokens"),
  condition("compare-tokens"),
  condition("already-done"),
  action("search-db"),
  condition("exists-in-db"),
  condition("is-valid"),
  action("send-alert-1"),
  action("send-alert-2"),
  action("query-history"),
  action("transform-data"),
  condition("has-prior-action"),
  action("execute-action-a"),
  action("check-state"),
  condition("state-ready"),
  action("execute-action-b"),
  action("notify-1"),
  condition("meets-threshold"),
  action("execute-action-c"),
  action("get-receipt"),
  action("notify-2"),
];

const edges: TestEdge[] = [
  te(FE_ID, "read-tokens", "loop"),
  te(FE_ID, COLLECT_ID, "done"),
  te("read-tokens", "compare-tokens"),
  te("compare-tokens", "already-done", "true"),
  te("already-done", "search-db", "false"),
  te("search-db", "exists-in-db"),
  te("exists-in-db", "is-valid", "true"),
  te("exists-in-db", "send-alert-2", "false"),
  te("is-valid", "query-history", "true"),
  te("is-valid", "send-alert-1", "false"),
  te("send-alert-1", "query-history"),
  te("send-alert-2", "query-history"),
  te("query-history", "transform-data"),
  te("transform-data", "has-prior-action"),
  te("has-prior-action", "check-state", "true"),
  te("has-prior-action", "execute-action-a", "false"),
  te("execute-action-a", "check-state"),
  te("check-state", "state-ready"),
  te("state-ready", "meets-threshold", "true"),
  te("state-ready", "execute-action-b", "false"),
  te("execute-action-b", "notify-1"),
  te("execute-action-b", "meets-threshold"),
  te("meets-threshold", "execute-action-c", "true"),
  te("execute-action-c", "get-receipt"),
  te("get-receipt", "notify-2"),
];

const edgesBySource = new Map<string, string[]>();
for (const edge of edges) {
  if (!edgesBySource.has(edge.source)) {
    edgesBySource.set(edge.source, []);
  }
  edgesBySource.get(edge.source)?.push(edge.target);
}

const edgesBySourceHandle = buildEdgesBySourceHandle(edges);

const nodeMap = new Map<string, any>();
for (const n of nodes) {
  nodeMap.set(n.id, n);
}

const body = identifyLoopBody(
  FE_ID,
  edgesBySource,
  nodeMap,
  edgesBySourceHandle
);

function route(conditionValue: boolean, nodeId: string): string[] {
  return resolveBodyConditionTargets(
    conditionValue,
    nodeId,
    body.bodyEdgesBySourceHandle,
    body.bodyEdgesBySource
  );
}

function evaluateAndRoute(
  expression: string,
  outputs: Record<string, { label: string; data: unknown }>,
  nodeId: string
): { result: boolean; targets: string[] } {
  const { result } = evaluateConditionExpression(expression, outputs);
  const targets = route(result, nodeId);
  return { result, targets };
}

const SPELL_ZERO_TOKENS = {
  spellTokens: { label: "Spell Tokens", data: { amt: "0" } },
};

const SPELL_HIGH_TOKENS = {
  spellTokens: {
    label: "Spell Tokens",
    data: { amt: "8291047382917492837461029384" },
  },
};

const HAT_TOKENS = {
  hatTokens: {
    label: "Hat Tokens",
    data: { amt: "6577716159627818993901156981" },
  },
};

const BATCH_CAST_TRUE = {
  batchRead: {
    label: "Batch Read",
    data: { results: [true, "1749820800", "1749907200"] },
  },
};

const BATCH_CAST_FALSE = {
  batchRead: {
    label: "Batch Read",
    data: { results: [false, "1749820800", "1749907200"] },
  },
};

const DB_FOUND = {
  dbResult: { label: "DB Result", data: { count: 1 } },
};

const DB_NOT_FOUND = {
  dbResult: { label: "DB Result", data: { count: 0 } },
};

const DB_WHITELISTED = {
  dbRow: { label: "DB Row", data: { success: true } },
};

const DB_NOT_WHITELISTED = {
  dbRow: { label: "DB Row", data: { success: false } },
};

const LIFT_EVENTS_FOUND = {
  liftFilter: { label: "Lift Filter", data: { matchCount: 3 } },
};

const LIFT_EVENTS_NONE = {
  liftFilter: { label: "Lift Filter", data: { matchCount: 0 } },
};

const SCHEDULE_FOUND = {
  scheduleTxns: { label: "Schedule Txns", data: { matchCount: 2 } },
};

const SCHEDULE_NOT_FOUND = {
  scheduleTxns: { label: "Schedule Txns", data: { matchCount: 0 } },
};

const CAN_CAST = {
  execStatus: {
    label: "Exec Status",
    data: { expiration: "1749993600", nextCastTime: "1749820800" },
  },
  systemTime: { label: "System Time", data: { unixTimestamp: 1_749_907_200 } },
};

const CANNOT_CAST = {
  execStatus: {
    label: "Exec Status",
    data: { expiration: "1749993600", nextCastTime: "1749993700" },
  },
  systemTime: { label: "System Time", data: { unixTimestamp: 1_749_907_200 } },
};

const EXPR_COMPARE =
  "{{@spellTokens:Spell Tokens.amt}} > {{@hatTokens:Hat Tokens.amt}}";
const EXPR_CAST_STATUS = "{{@batchRead:Batch Read.results[0]}} === true";
const EXPR_DB_COUNT = "{{@dbResult:DB Result.count}} === 1";
const EXPR_WHITELIST = "{{@dbRow:DB Row.success}} === true";
const EXPR_LIFT_COUNT = "{{@liftFilter:Lift Filter.matchCount}} > 0";
const EXPR_SCHEDULE_COUNT = "{{@scheduleTxns:Schedule Txns.matchCount}} !== 0";
const EXPR_CAN_CAST =
  "{{@execStatus:Exec Status.expiration}} >= {{@systemTime:System Time.unixTimestamp}} && {{@systemTime:System Time.unixTimestamp}} >= {{@execStatus:Exec Status.nextCastTime}}";

describe("For Each body: 7 chained conditions with real web3 values", () => {
  describe("body identification", () => {
    it("collects 20 body nodes with correct boundary", () => {
      // Canonical handle wiring: Collect sits on the For Each's `done`
      // sourceHandle, so the body subgraph (loop-handle reachable nodes)
      // doesn't include it.
      expect(body.doneCollectNodeId).toBe(COLLECT_ID);
      expect(body.collectNodeId).toBeUndefined();
      expect(body.bodyNodeIds).toHaveLength(20);
      expect(body.bodyNodeIds).not.toContain(FE_ID);
      expect(body.bodyNodeIds).not.toContain(COLLECT_ID);
    });

    it("includes all 7 condition nodes", () => {
      for (const id of [
        "compare-tokens",
        "already-done",
        "exists-in-db",
        "is-valid",
        "has-prior-action",
        "state-ready",
        "meets-threshold",
      ]) {
        expect(body.bodyNodeIds).toContain(id);
      }
    });
  });

  describe("C1 compare-tokens: 0 tokens vs 6.5e27 hat -> nothing runs", () => {
    it("evaluates false, dispatches nothing", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_COMPARE,
        { ...SPELL_ZERO_TOKENS, ...HAT_TOKENS },
        "compare-tokens"
      );
      expect(result).toBe(false);
      expect(targets).toEqual([]);
    });
  });

  describe("C1 compare-tokens: 8.2e27 spell vs 6.5e27 hat -> already-done runs", () => {
    it("evaluates true, dispatches to already-done", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_COMPARE,
        { ...SPELL_HIGH_TOKENS, ...HAT_TOKENS },
        "compare-tokens"
      );
      expect(result).toBe(true);
      expect(targets).toEqual(["already-done"]);
    });
  });

  describe("C1 compare-tokens: equal amounts -> nothing runs", () => {
    it("not strictly greater, dispatches nothing", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_COMPARE,
        {
          spellTokens: {
            label: "Spell Tokens",
            data: { amt: "6577716159627818993901156981" },
          },
          ...HAT_TOKENS,
        },
        "compare-tokens"
      );
      expect(result).toBe(false);
      expect(targets).toEqual([]);
    });
  });

  describe("C1 compare-tokens: spell exceeds hat by 1 wei -> already-done runs", () => {
    it("evaluates true at 1 wei difference", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_COMPARE,
        {
          spellTokens: {
            label: "Spell Tokens",
            data: { amt: "6577716159627818993901156982" },
          },
          ...HAT_TOKENS,
        },
        "compare-tokens"
      );
      expect(result).toBe(true);
      expect(targets).toEqual(["already-done"]);
    });
  });

  describe("C1 compare-tokens: above MAX_SAFE_INTEGER boundary -> correct BigInt comparison", () => {
    it("9007199254740993 > 9007199254740992 evaluates true", () => {
      const { result } = evaluateAndRoute(
        EXPR_COMPARE,
        {
          spellTokens: {
            label: "Spell Tokens",
            data: { amt: "9007199254740993" },
          },
          hatTokens: { label: "Hat Tokens", data: { amt: "9007199254740992" } },
        },
        "compare-tokens"
      );
      expect(result).toBe(true);
    });
  });

  describe("C1 compare-tokens: uint256 max range -> correct comparison", () => {
    it("max-1 < max evaluates correctly", () => {
      const { result } = evaluateAndRoute(
        EXPR_COMPARE,
        {
          spellTokens: {
            label: "Spell Tokens",
            data: {
              amt: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            },
          },
          hatTokens: {
            label: "Hat Tokens",
            data: {
              amt: "115792089237316195423570985008687907853269984665640564039457584007913129639934",
            },
          },
        },
        "compare-tokens"
      );
      expect(result).toBe(true);
    });
  });

  describe("C1 compare-tokens: both zero -> nothing runs", () => {
    it("0 is not > 0", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_COMPARE,
        {
          spellTokens: { label: "Spell Tokens", data: { amt: "0" } },
          hatTokens: { label: "Hat Tokens", data: { amt: "0" } },
        },
        "compare-tokens"
      );
      expect(result).toBe(false);
      expect(targets).toEqual([]);
    });
  });

  describe("C2 already-done: cast=true -> nothing runs (already handled)", () => {
    it("evaluates true, dispatches nothing", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_CAST_STATUS,
        BATCH_CAST_TRUE,
        "already-done"
      );
      expect(result).toBe(true);
      expect(targets).toEqual([]);
    });
  });

  describe("C2 already-done: cast=false -> search-db runs", () => {
    it("evaluates false, dispatches to search-db", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_CAST_STATUS,
        BATCH_CAST_FALSE,
        "already-done"
      );
      expect(result).toBe(false);
      expect(targets).toEqual(["search-db"]);
    });
  });

  describe("C3 exists-in-db: count=1 -> is-valid runs, send-alert-2 does not", () => {
    it("evaluates true, dispatches to is-valid", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_DB_COUNT,
        DB_FOUND,
        "exists-in-db"
      );
      expect(result).toBe(true);
      expect(targets).toEqual(["is-valid"]);
    });
  });

  describe("C3 exists-in-db: count=0 -> send-alert-2 runs, is-valid does not", () => {
    it("evaluates false, dispatches to send-alert-2", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_DB_COUNT,
        DB_NOT_FOUND,
        "exists-in-db"
      );
      expect(result).toBe(false);
      expect(targets).toEqual(["send-alert-2"]);
    });
  });

  describe("C4 is-valid: whitelisted -> query-history runs, send-alert-1 does not", () => {
    it("evaluates true, dispatches to query-history", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_WHITELIST,
        DB_WHITELISTED,
        "is-valid"
      );
      expect(result).toBe(true);
      expect(targets).toEqual(["query-history"]);
    });
  });

  describe("C4 is-valid: not whitelisted -> send-alert-1 runs, query-history does not", () => {
    it("evaluates false, dispatches to send-alert-1", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_WHITELIST,
        DB_NOT_WHITELISTED,
        "is-valid"
      );
      expect(result).toBe(false);
      expect(targets).toEqual(["send-alert-1"]);
    });
  });

  describe("C5 has-prior-action: 3 events -> check-state runs, execute-action-a does not", () => {
    it("evaluates true, dispatches to check-state", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_LIFT_COUNT,
        LIFT_EVENTS_FOUND,
        "has-prior-action"
      );
      expect(result).toBe(true);
      expect(targets).toEqual(["check-state"]);
    });
  });

  describe("C5 has-prior-action: 0 events -> execute-action-a runs, check-state does not", () => {
    it("evaluates false, dispatches to execute-action-a", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_LIFT_COUNT,
        LIFT_EVENTS_NONE,
        "has-prior-action"
      );
      expect(result).toBe(false);
      expect(targets).toEqual(["execute-action-a"]);
    });
  });

  describe("C6 state-ready: 2 txns -> meets-threshold runs, execute-action-b does not", () => {
    it("evaluates true, dispatches to meets-threshold", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_SCHEDULE_COUNT,
        SCHEDULE_FOUND,
        "state-ready"
      );
      expect(result).toBe(true);
      expect(targets).toEqual(["meets-threshold"]);
    });
  });

  describe("C6 state-ready: 0 txns -> execute-action-b runs, meets-threshold does not", () => {
    it("evaluates false, dispatches to execute-action-b", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_SCHEDULE_COUNT,
        SCHEDULE_NOT_FOUND,
        "state-ready"
      );
      expect(result).toBe(false);
      expect(targets).toEqual(["execute-action-b"]);
    });
  });

  describe("C7 meets-threshold: expiration valid + past cast time -> execute-action-c runs", () => {
    it("evaluates true, dispatches to execute-action-c", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_CAN_CAST,
        CAN_CAST,
        "meets-threshold"
      );
      expect(result).toBe(true);
      expect(targets).toEqual(["execute-action-c"]);
    });
  });

  describe("C7 meets-threshold: cast time in future -> nothing runs", () => {
    it("evaluates false, dispatches nothing", () => {
      const { result, targets } = evaluateAndRoute(
        EXPR_CAN_CAST,
        CANNOT_CAST,
        "meets-threshold"
      );
      expect(result).toBe(false);
      expect(targets).toEqual([]);
    });
  });

  describe("full path: all gates pass -> executes through to notify-2", () => {
    it("C1-C7 all favorable: every node in the happy path runs", () => {
      const c1 = evaluateAndRoute(
        EXPR_COMPARE,
        { ...SPELL_HIGH_TOKENS, ...HAT_TOKENS },
        "compare-tokens"
      );
      expect(c1.targets).toEqual(["already-done"]);

      const c2 = evaluateAndRoute(
        EXPR_CAST_STATUS,
        BATCH_CAST_FALSE,
        "already-done"
      );
      expect(c2.targets).toEqual(["search-db"]);

      const c3 = evaluateAndRoute(EXPR_DB_COUNT, DB_FOUND, "exists-in-db");
      expect(c3.targets).toEqual(["is-valid"]);

      const c4 = evaluateAndRoute(EXPR_WHITELIST, DB_WHITELISTED, "is-valid");
      expect(c4.targets).toEqual(["query-history"]);

      const c5 = evaluateAndRoute(
        EXPR_LIFT_COUNT,
        LIFT_EVENTS_FOUND,
        "has-prior-action"
      );
      expect(c5.targets).toEqual(["check-state"]);

      const c6 = evaluateAndRoute(
        EXPR_SCHEDULE_COUNT,
        SCHEDULE_FOUND,
        "state-ready"
      );
      expect(c6.targets).toEqual(["meets-threshold"]);

      const c7 = evaluateAndRoute(EXPR_CAN_CAST, CAN_CAST, "meets-threshold");
      expect(c7.targets).toEqual(["execute-action-c"]);
    });
  });

  describe("full path: 0 tokens -> nothing beyond C1 runs", () => {
    it("C1 false: search-db, exists-in-db, all downstream nodes are dead", () => {
      const c1 = evaluateAndRoute(
        EXPR_COMPARE,
        { ...SPELL_ZERO_TOKENS, ...HAT_TOKENS },
        "compare-tokens"
      );
      expect(c1.result).toBe(false);
      expect(c1.targets).toEqual([]);
    });
  });

  describe("full path: already cast -> nothing beyond C2 runs", () => {
    it("C1 true, C2 true: search-db never reached", () => {
      const c1 = evaluateAndRoute(
        EXPR_COMPARE,
        { ...SPELL_HIGH_TOKENS, ...HAT_TOKENS },
        "compare-tokens"
      );
      expect(c1.targets).toEqual(["already-done"]);

      const c2 = evaluateAndRoute(
        EXPR_CAST_STATUS,
        BATCH_CAST_TRUE,
        "already-done"
      );
      expect(c2.targets).toEqual([]);
    });
  });

  describe("full path: not in DB -> send-alert-2 runs, is-valid does not run", () => {
    it("C3 false dispatches alert, convergence continues to query-history", () => {
      const c3 = evaluateAndRoute(EXPR_DB_COUNT, DB_NOT_FOUND, "exists-in-db");
      expect(c3.targets).toEqual(["send-alert-2"]);
    });
  });

  describe("full path: in DB but not whitelisted -> send-alert-1 runs, query-history does not run directly", () => {
    it("C3 true then C4 false dispatches alert", () => {
      const c3 = evaluateAndRoute(EXPR_DB_COUNT, DB_FOUND, "exists-in-db");
      expect(c3.targets).toEqual(["is-valid"]);

      const c4 = evaluateAndRoute(
        EXPR_WHITELIST,
        DB_NOT_WHITELISTED,
        "is-valid"
      );
      expect(c4.targets).toEqual(["send-alert-1"]);
    });
  });

  describe("full path: no lift, no schedule, cannot cast -> lifts, schedules, then stops at C7", () => {
    it("C5 false, C6 false, C7 false: execute-action-a and execute-action-b run, execute-action-c does not", () => {
      const c5 = evaluateAndRoute(
        EXPR_LIFT_COUNT,
        LIFT_EVENTS_NONE,
        "has-prior-action"
      );
      expect(c5.targets).toEqual(["execute-action-a"]);

      const c6 = evaluateAndRoute(
        EXPR_SCHEDULE_COUNT,
        SCHEDULE_NOT_FOUND,
        "state-ready"
      );
      expect(c6.targets).toEqual(["execute-action-b"]);

      const c7 = evaluateAndRoute(
        EXPR_CAN_CAST,
        CANNOT_CAST,
        "meets-threshold"
      );
      expect(c7.targets).toEqual([]);
    });
  });

  describe("exhaustive C5 x C6 x C7: all 8 combinations", () => {
    const combos: Array<{
      c5Events: typeof LIFT_EVENTS_FOUND;
      c6Txns: typeof SCHEDULE_FOUND;
      c7Status: typeof CAN_CAST;
      desc: string;
      c5Runs: string;
      c6Runs: string;
      c7Runs: string[];
    }> = [
      {
        c5Events: LIFT_EVENTS_FOUND,
        c6Txns: SCHEDULE_FOUND,
        c7Status: CAN_CAST,
        desc: "lifted + scheduled + castable -> check-state, meets-threshold, execute-action-c all run",
        c5Runs: "check-state",
        c6Runs: "meets-threshold",
        c7Runs: ["execute-action-c"],
      },
      {
        c5Events: LIFT_EVENTS_FOUND,
        c6Txns: SCHEDULE_FOUND,
        c7Status: CANNOT_CAST,
        desc: "lifted + scheduled + not castable -> check-state, meets-threshold run, execute-action-c does not",
        c5Runs: "check-state",
        c6Runs: "meets-threshold",
        c7Runs: [],
      },
      {
        c5Events: LIFT_EVENTS_FOUND,
        c6Txns: SCHEDULE_NOT_FOUND,
        c7Status: CAN_CAST,
        desc: "lifted + not scheduled + castable -> check-state, execute-action-b, execute-action-c run",
        c5Runs: "check-state",
        c6Runs: "execute-action-b",
        c7Runs: ["execute-action-c"],
      },
      {
        c5Events: LIFT_EVENTS_FOUND,
        c6Txns: SCHEDULE_NOT_FOUND,
        c7Status: CANNOT_CAST,
        desc: "lifted + not scheduled + not castable -> check-state, execute-action-b run, execute-action-c does not",
        c5Runs: "check-state",
        c6Runs: "execute-action-b",
        c7Runs: [],
      },
      {
        c5Events: LIFT_EVENTS_NONE,
        c6Txns: SCHEDULE_FOUND,
        c7Status: CAN_CAST,
        desc: "not lifted + scheduled + castable -> execute-action-a, meets-threshold, execute-action-c run",
        c5Runs: "execute-action-a",
        c6Runs: "meets-threshold",
        c7Runs: ["execute-action-c"],
      },
      {
        c5Events: LIFT_EVENTS_NONE,
        c6Txns: SCHEDULE_FOUND,
        c7Status: CANNOT_CAST,
        desc: "not lifted + scheduled + not castable -> execute-action-a, meets-threshold run, execute-action-c does not",
        c5Runs: "execute-action-a",
        c6Runs: "meets-threshold",
        c7Runs: [],
      },
      {
        c5Events: LIFT_EVENTS_NONE,
        c6Txns: SCHEDULE_NOT_FOUND,
        c7Status: CAN_CAST,
        desc: "not lifted + not scheduled + castable -> execute-action-a, execute-action-b, execute-action-c all run",
        c5Runs: "execute-action-a",
        c6Runs: "execute-action-b",
        c7Runs: ["execute-action-c"],
      },
      {
        c5Events: LIFT_EVENTS_NONE,
        c6Txns: SCHEDULE_NOT_FOUND,
        c7Status: CANNOT_CAST,
        desc: "not lifted + not scheduled + not castable -> execute-action-a, execute-action-b run, execute-action-c does not",
        c5Runs: "execute-action-a",
        c6Runs: "execute-action-b",
        c7Runs: [],
      },
    ];

    for (const combo of combos) {
      it(combo.desc, () => {
        const c5 = evaluateAndRoute(
          EXPR_LIFT_COUNT,
          combo.c5Events,
          "has-prior-action"
        );
        expect(c5.targets).toEqual([combo.c5Runs]);

        const c6 = evaluateAndRoute(
          EXPR_SCHEDULE_COUNT,
          combo.c6Txns,
          "state-ready"
        );
        expect(c6.targets).toEqual([combo.c6Runs]);

        const c7 = evaluateAndRoute(
          EXPR_CAN_CAST,
          combo.c7Status,
          "meets-threshold"
        );
        expect(c7.targets).toEqual(combo.c7Runs);
      });
    }
  });

  describe("exhaustive C3 x C4: all convergence paths", () => {
    it("found + whitelisted -> is-valid runs, query-history runs, no alerts", () => {
      const c3 = evaluateAndRoute(EXPR_DB_COUNT, DB_FOUND, "exists-in-db");
      expect(c3.targets).toEqual(["is-valid"]);

      const c4 = evaluateAndRoute(EXPR_WHITELIST, DB_WHITELISTED, "is-valid");
      expect(c4.targets).toEqual(["query-history"]);
    });

    it("found + not whitelisted -> is-valid runs, send-alert-1 runs, query-history does not run directly", () => {
      const c3 = evaluateAndRoute(EXPR_DB_COUNT, DB_FOUND, "exists-in-db");
      expect(c3.targets).toEqual(["is-valid"]);

      const c4 = evaluateAndRoute(
        EXPR_WHITELIST,
        DB_NOT_WHITELISTED,
        "is-valid"
      );
      expect(c4.targets).toEqual(["send-alert-1"]);
    });

    it("not found -> send-alert-2 runs, is-valid does not run", () => {
      const c3 = evaluateAndRoute(EXPR_DB_COUNT, DB_NOT_FOUND, "exists-in-db");
      expect(c3.targets).toEqual(["send-alert-2"]);
    });
  });

  describe("one-sided gates never leak to wrong targets", () => {
    it("C1 false: already-done, search-db, exists-in-db never dispatched", () => {
      const { targets } = evaluateAndRoute(
        EXPR_COMPARE,
        { ...SPELL_ZERO_TOKENS, ...HAT_TOKENS },
        "compare-tokens"
      );
      expect(targets).not.toContain("already-done");
      expect(targets).not.toContain("search-db");
      expect(targets).not.toContain("exists-in-db");
    });

    it("C2 true: search-db, exists-in-db, query-history never dispatched", () => {
      const { targets } = evaluateAndRoute(
        EXPR_CAST_STATUS,
        BATCH_CAST_TRUE,
        "already-done"
      );
      expect(targets).not.toContain("search-db");
      expect(targets).not.toContain("exists-in-db");
      expect(targets).not.toContain("query-history");
    });

    it("C7 false: execute-action-c, get-receipt, notify-2 never dispatched", () => {
      const { targets } = evaluateAndRoute(
        EXPR_CAN_CAST,
        CANNOT_CAST,
        "meets-threshold"
      );
      expect(targets).not.toContain("execute-action-c");
      expect(targets).not.toContain("get-receipt");
      expect(targets).not.toContain("notify-2");
    });
  });

  describe("BigInt edge cases at token comparison boundary", () => {
    it("28-digit values differing by 1: lower does not pass, higher passes", () => {
      const { result: r1 } = evaluateAndRoute(
        EXPR_COMPARE,
        {
          spellTokens: {
            label: "Spell Tokens",
            data: { amt: "1000000000000000000000000000" },
          },
          hatTokens: {
            label: "Hat Tokens",
            data: { amt: "1000000000000000000000000001" },
          },
        },
        "compare-tokens"
      );
      expect(r1).toBe(false);

      const { result: r2 } = evaluateAndRoute(
        EXPR_COMPARE,
        {
          spellTokens: {
            label: "Spell Tokens",
            data: { amt: "1000000000000000000000000002" },
          },
          hatTokens: {
            label: "Hat Tokens",
            data: { amt: "1000000000000000000000000001" },
          },
        },
        "compare-tokens"
      );
      expect(r2).toBe(true);
    });
  });
});
