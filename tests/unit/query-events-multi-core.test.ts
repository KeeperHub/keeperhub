import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import {
  MAX_EVENT_QUERIES,
  parseEventQueries,
  planLogQueries,
  queryPlannedEvents,
  type ResolvedEventQuery,
} from "@/plugins/web3/steps/query-events-multi-core";
import { emitted, FakeLogNode, singleNodeRpc } from "../mocks/fake-log-node";

// Placeholder addresses, not real deployments.
const VAULT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const ORACLE = "0x3333333333333333333333333333333333333333";
const ALICE = "0x4444444444444444444444444444444444444444";
const BOB = "0x5555555555555555555555555555555555555555";
const CAROL = "0x6666666666666666666666666666666666666666";

const PAUSABLE = new ethers.Interface([
  "event Paused(address account)",
  "event Unpaused(address account)",
]);
const TOKEN_EVENTS = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Paused(address account)",
]);
const PAUSABLE_ABI = PAUSABLE.formatJson();
const TOKEN_ABI = TOKEN_EVENTS.formatJson();

function topicOf(iface: ethers.Interface, event: string): string {
  const fragment = iface.getEvent(event);
  if (!fragment) {
    throw new Error(`no event ${event}`);
  }
  return fragment.topicHash;
}

function entry(
  contractAddress: string,
  abi: string,
  eventName: string,
  eventArgs?: unknown
): Record<string, unknown> {
  return eventArgs === undefined
    ? { contractAddress, abi, eventName }
    : { contractAddress, abi, eventName, eventArgs };
}

function resolved(entries: unknown[]): ResolvedEventQuery[] {
  const result = parseEventQueries(entries);
  if (!result.success) {
    throw new Error(`expected entries to parse, got: ${result.error}`);
  }
  return result.queries;
}

function parseError(raw: unknown): {
  error: string;
  destinationError?: true;
} {
  const result = parseEventQueries(raw);
  if (result.success) {
    throw new Error("expected a validation error");
  }
  return result;
}

describe("parseEventQueries", () => {
  it("reads the JSON string the editor stores and the array an API caller stores", () => {
    const entries = [
      entry(VAULT.toLowerCase(), PAUSABLE_ABI, "Paused"),
      entry(TOKEN, TOKEN_ABI, "Transfer", { from: ALICE }),
    ];

    for (const raw of [entries, JSON.stringify(entries)]) {
      const queries = resolved(raw as unknown[]);
      expect(queries.map((q) => q.fragment.name)).toEqual([
        "Paused",
        "Transfer",
      ]);
      expect(queries[0].contractAddress).toBe(ethers.getAddress(VAULT));
      expect(queries[0].topics).toBeNull();
      expect(queries[1].topics).toEqual([
        topicOf(TOKEN_EVENTS, "Transfer"),
        ethers.zeroPadValue(ALICE, 32),
      ]);
    }
  });

  it("accepts a filter stored as a JSON string, as the single-event field stores it", () => {
    const [query] = resolved([
      entry(TOKEN, TOKEN_ABI, "Transfer", JSON.stringify({ to: BOB })),
    ]);
    expect(query.topics).toEqual([
      topicOf(TOKEN_EVENTS, "Transfer"),
      null,
      ethers.zeroPadValue(BOB, 32),
    ]);
  });

  it("refuses a missing, empty or malformed list as having nothing to query, which is never softened", () => {
    for (const raw of [undefined, null, "", "   ", "[]", [], "{}", "nope", 5]) {
      const failure = parseError(raw);
      expect(failure.destinationError, String(raw)).toBe(true);
    }
  });

  it(`accepts ${MAX_EVENT_QUERIES} entries and refuses one more`, () => {
    const atCap = Array.from({ length: MAX_EVENT_QUERIES }, () =>
      entry(VAULT, PAUSABLE_ABI, "Paused")
    );
    expect(resolved(atCap)).toHaveLength(MAX_EVENT_QUERIES);

    const failure = parseError([
      ...atCap,
      entry(VAULT, PAUSABLE_ABI, "Paused"),
    ]);
    expect(failure.error).toContain(`${MAX_EVENT_QUERIES + 1} events`);
    expect(failure.error).toContain(`${MAX_EVENT_QUERIES}`);
    expect(failure.destinationError).toBeUndefined();
  });

  it("names the entry at fault", () => {
    const valid = entry(VAULT, PAUSABLE_ABI, "Paused");
    const cases: [unknown, string][] = [
      ["not an object", "Event 2 must be an object"],
      [
        entry("", PAUSABLE_ABI, "Paused"),
        "Event 2 is missing a contract address",
      ],
      [
        entry("0x1234", PAUSABLE_ABI, "Paused"),
        "Event 2 has an invalid contract address: 0x1234",
      ],
      [entry(VAULT, PAUSABLE_ABI, ""), "Event 2 is missing an event name"],
      [
        entry(VAULT, "", "Paused"),
        "Event 2 (Paused) is missing its contract ABI",
      ],
      [
        entry(VAULT, "{not json", "Paused"),
        "Event 2 (Paused): Invalid ABI JSON",
      ],
      [
        entry(VAULT, PAUSABLE_ABI, "Upgraded"),
        "Event 2 (Upgraded): Event 'Upgraded' not found in ABI",
      ],
      [
        entry(TOKEN, TOKEN_ABI, "Transfer", { value: "1" }),
        "Event 2 (Transfer): 'value' is not an indexed parameter",
      ],
      [
        entry(TOKEN, TOKEN_ABI, "Transfer", { from: "" }),
        "Event 2 (Transfer): Filter for 'from' is empty",
      ],
    ];

    for (const [bad, message] of cases) {
      expect(parseError([valid, bad]).error).toContain(message);
    }
  });

  it("treats a bad contract address as a destination failure and a bad ABI as payload", () => {
    expect(
      parseError([entry("0x1234", PAUSABLE_ABI, "Paused")]).destinationError
    ).toBe(true);
    expect(
      parseError([entry(VAULT, PAUSABLE_ABI, "Upgraded")]).destinationError
    ).toBeUndefined();
  });

  it("refuses an anonymous event, whose logs carry no signature topic", () => {
    const abi = JSON.stringify([
      {
        type: "event",
        name: "Poked",
        anonymous: true,
        inputs: [{ name: "who", type: "address", indexed: false }],
      },
    ]);
    expect(parseError([entry(VAULT, abi, "Poked")]).error).toContain(
      "anonymous"
    );
  });
});

describe("planLogQueries", () => {
  it("shares one call across the unfiltered events of one contract", () => {
    const plans = planLogQueries(
      resolved([
        entry(VAULT, PAUSABLE_ABI, "Paused"),
        entry(VAULT, PAUSABLE_ABI, "Unpaused"),
      ])
    );

    expect(plans).toHaveLength(1);
    expect(plans[0].addresses).toEqual([ethers.getAddress(VAULT)]);
    expect(plans[0].topics).toEqual([
      [topicOf(PAUSABLE, "Paused"), topicOf(PAUSABLE, "Unpaused")].sort(),
    ]);
  });

  it("shares one call across contracts watching the same events", () => {
    const plans = planLogQueries(
      resolved([
        entry(VAULT, PAUSABLE_ABI, "Paused"),
        entry(ORACLE, PAUSABLE_ABI, "Unpaused"),
        entry(ORACLE, PAUSABLE_ABI, "Paused"),
        entry(VAULT, PAUSABLE_ABI, "Unpaused"),
      ])
    );

    expect(plans).toHaveLength(1);
    expect(plans[0].addresses).toEqual([
      ethers.getAddress(VAULT),
      ethers.getAddress(ORACLE),
    ]);
  });

  it("keeps contracts watching different events apart, so none is asked for another's events", () => {
    const plans = planLogQueries(
      resolved([
        entry(VAULT, PAUSABLE_ABI, "Unpaused"),
        entry(TOKEN, TOKEN_ABI, "Transfer"),
      ])
    );

    expect(plans.map((p) => [p.addresses, p.topics])).toEqual([
      [[ethers.getAddress(VAULT)], [topicOf(PAUSABLE, "Unpaused")]],
      [[ethers.getAddress(TOKEN)], [topicOf(TOKEN_EVENTS, "Transfer")]],
    ]);
  });

  it("gives a filtered entry a call of its own carrying its compiled topics", () => {
    const plans = planLogQueries(
      resolved([
        entry(TOKEN, TOKEN_ABI, "Paused"),
        entry(TOKEN, TOKEN_ABI, "Transfer", { from: ALICE }),
      ])
    );

    expect(plans.map((p) => [p.addresses, p.topics])).toEqual([
      [[ethers.getAddress(TOKEN)], [topicOf(TOKEN_EVENTS, "Paused")]],
      [
        [ethers.getAddress(TOKEN)],
        [topicOf(TOKEN_EVENTS, "Transfer"), ethers.zeroPadValue(ALICE, 32)],
      ],
    ]);
  });

  it("covers ten event types across three contracts with three calls", () => {
    const events = Array.from(
      { length: 10 },
      (_, i) => `event E${i}(uint256 v)`
    );
    const abi = new ethers.Interface(events).formatJson();
    const pairs = [
      ...[0, 1, 2, 3, 4].map((i) => entry(VAULT, abi, `E${i}`)),
      ...[3, 4, 5, 6, 7].map((i) => entry(TOKEN, abi, `E${i}`)),
      ...[6, 7, 8, 9].map((i) => entry(ORACLE, abi, `E${i}`)),
    ];

    expect(pairs).toHaveLength(14);
    expect(planLogQueries(resolved(pairs))).toHaveLength(3);
  });
});

describe("queryPlannedEvents", () => {
  const range = { fromBlock: 100, toBlock: 200, toBlockIsLatest: false };

  it("merges events across contracts and events in block then log order, each tagged with its source", async () => {
    const node = new FakeLogNode(1000, [
      emitted(TOKEN, TOKEN_EVENTS, "Transfer", [ALICE, BOB, BigInt(7)], 150, 3),
      emitted(VAULT, PAUSABLE, "Paused", [ALICE], 120, 0),
      emitted(VAULT, PAUSABLE, "Unpaused", [ALICE], 150, 1),
      emitted(ORACLE, PAUSABLE, "Paused", [BOB], 130, 2),
      // Neither watched: a Paused on the token and an Unpaused on the oracle.
      emitted(TOKEN, TOKEN_EVENTS, "Paused", [ALICE], 140, 0),
      emitted(ORACLE, PAUSABLE, "Unpaused", [BOB], 160, 0),
    ]);
    const plans = planLogQueries(
      resolved([
        entry(VAULT, PAUSABLE_ABI, "Paused"),
        entry(VAULT, PAUSABLE_ABI, "Unpaused"),
        entry(TOKEN, TOKEN_ABI, "Transfer"),
        entry(ORACLE, PAUSABLE_ABI, "Paused"),
      ])
    );

    const events = await queryPlannedEvents(singleNodeRpc(node), plans, range);

    expect(
      events.map((e) => [
        e.blockNumber,
        e.logIndex,
        e.contractAddress,
        e.eventName,
      ])
    ).toEqual([
      [120, 0, ethers.getAddress(VAULT), "Paused"],
      [130, 2, ethers.getAddress(ORACLE), "Paused"],
      [150, 1, ethers.getAddress(VAULT), "Unpaused"],
      [150, 3, ethers.getAddress(TOKEN), "Transfer"],
    ]);
    expect(events[3]).toEqual({
      contractAddress: ethers.getAddress(TOKEN),
      eventName: "Transfer",
      blockNumber: 150,
      transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      logIndex: 3,
      args: { from: ALICE, to: BOB, value: "7" },
    });
  });

  it("applies each entry's indexed filter at the RPC and returns a log both match once", async () => {
    const node = new FakeLogNode(1000, [
      emitted(TOKEN, TOKEN_EVENTS, "Transfer", [ALICE, BOB, BigInt(1)], 110, 0),
      emitted(
        TOKEN,
        TOKEN_EVENTS,
        "Transfer",
        [ALICE, CAROL, BigInt(2)],
        120,
        0
      ),
      emitted(TOKEN, TOKEN_EVENTS, "Transfer", [CAROL, BOB, BigInt(3)], 130, 0),
      emitted(
        TOKEN,
        TOKEN_EVENTS,
        "Transfer",
        [CAROL, CAROL, BigInt(4)],
        140,
        0
      ),
    ]);
    const plans = planLogQueries(
      resolved([
        entry(TOKEN, TOKEN_ABI, "Transfer", { from: ALICE }),
        entry(TOKEN, TOKEN_ABI, "Transfer", { to: BOB }),
      ])
    );

    const events = await queryPlannedEvents(singleNodeRpc(node), plans, range);

    expect(events.map((e) => e.args.value)).toEqual(["1", "2", "3"]);
    expect(node.getLogsCalls.map((call) => call.topics)).toEqual([
      [topicOf(TOKEN_EVENTS, "Transfer"), ethers.zeroPadValue(ALICE, 32)],
      [topicOf(TOKEN_EVENTS, "Transfer"), null, ethers.zeroPadValue(BOB, 32)],
    ]);
  });

  it("scans every call over the same fixed batches, never against latest", async () => {
    const node = new FakeLogNode(10_000);
    const plans = planLogQueries(
      resolved([
        entry(VAULT, PAUSABLE_ABI, "Paused"),
        entry(TOKEN, TOKEN_ABI, "Transfer", { from: ALICE }),
      ])
    );

    await queryPlannedEvents(singleNodeRpc(node), plans, {
      fromBlock: 0,
      toBlock: 4500,
      toBlockIsLatest: true,
    });

    const windows = node.getLogsCalls.map((call) => [
      Number(call.fromBlock),
      Number(call.toBlock),
    ]);
    expect(windows).toEqual([
      [0, 1999],
      [0, 1999],
      [2000, 3999],
      [2000, 3999],
      [4000, 4500],
      [4000, 4500],
    ]);
  });

  it("skips a log with the watched signature that the entry's ABI cannot decode", async () => {
    const transfer = topicOf(TOKEN_EVENTS, "Transfer");
    const node = new FakeLogNode(1000, [
      // ERC-721 style: same signature, the amount indexed instead of in data.
      {
        address: TOKEN,
        topics: [
          transfer,
          ethers.zeroPadValue(ALICE, 32),
          ethers.zeroPadValue(BOB, 32),
          ethers.zeroPadValue("0x01", 32),
        ],
        data: "0x",
        blockNumber: 150,
        logIndex: 0,
      },
      emitted(TOKEN, TOKEN_EVENTS, "Transfer", [ALICE, BOB, BigInt(9)], 151, 0),
    ]);
    const plans = planLogQueries(
      resolved([entry(TOKEN, TOKEN_ABI, "Transfer")])
    );

    const events = await queryPlannedEvents(singleNodeRpc(node), plans, range);

    expect(events.map((e) => e.blockNumber)).toEqual([151]);
  });
});
