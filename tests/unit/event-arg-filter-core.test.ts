import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import {
  buildEventArgTopics,
  indexedParams,
} from "@/plugins/web3/steps/event-arg-filter-core";

const TRANSFER = ethers.EventFragment.from(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
const MIXED = ethers.EventFragment.from(
  "event Mixed(int256 indexed delta, string indexed label, bool indexed flag)"
);
const WITH_ARRAY = ethers.EventFragment.from(
  "event Batched(uint256[] indexed ids, address indexed who)"
);
const UNINDEXED_ONLY = ethers.EventFragment.from("event Plain(uint256 amount)");

// A shaped-but-meaningless address: these tests check encoding and
// validation, so a real deployment would only invite the question of which
// one it is.
const ALICE = "0x1111111111111111111111111111111111111111";

function ok(raw: string | undefined, fragment: ethers.EventFragment) {
  const result = buildEventArgTopics(raw, fragment);
  if (!result.success) {
    throw new Error(`expected success, got: ${result.error}`);
  }
  return result;
}

function err(raw: string, fragment: ethers.EventFragment): string {
  const result = buildEventArgTopics(raw, fragment);
  if (result.success) {
    throw new Error("expected a validation error");
  }
  return result.error;
}

describe("buildEventArgTopics", () => {
  it("returns no topic filter when nothing is being filtered", () => {
    for (const raw of [undefined, "", "   ", "{}"]) {
      expect(ok(raw, TRANSFER).topics, String(raw)).toBeNull();
    }
  });

  it("rejects a present-but-empty value instead of scanning unfiltered", () => {
    // The failure this guards against is a template: {"to": "{{X.address}}"}
    // where the upstream node returns "". Dropping the key would leave the
    // step scanning the whole range and returning every event as though the
    // filter had matched everything -- the silent-unfiltered-scan shape.
    for (const raw of ['{"from":""}', '{"from":"   "}', '{"from":null}']) {
      expect(err(raw, TRANSFER), raw).toContain("is empty");
    }
  });

  it("accepts the filter as an object, as an API caller would store it", () => {
    const { topics } = ok({ from: ALICE } as unknown as string, TRANSFER);
    expect(topics).toEqual([
      TRANSFER.topicHash,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
  });

  it("trims a pasted value rather than failing it as malformed", () => {
    const { topics } = ok(`{"from":"  ${ALICE}  "}`, TRANSFER);
    expect(topics?.[1]).toBe(
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE])
    );
  });

  it("accepts an address that is not EIP-55 checksummed", () => {
    // The shape check is ethers-free so it cannot verify a checksum; the
    // encoder would reject a mixed-case one, and the topic is the lowercase
    // value either way.
    const { topics } = ok(
      `{"from":"${ALICE.toUpperCase().replace("0X", "0x")}"}`,
      TRANSFER
    );
    expect(topics?.[1]).toBe(
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE])
    );
  });

  it("keeps the topic slot of an unnamed indexed parameter", () => {
    // An unnamed parameter cannot be filtered by name, but it still holds a
    // topic position: ignoring it would shift a later filter onto the wrong
    // topic and match nothing.
    const fragment = ethers.EventFragment.from(
      "event Mixed(address indexed, address indexed to)"
    );
    const { topics } = ok(`{"to":"${ALICE}"}`, fragment);
    expect(topics).toEqual([
      fragment.topicHash,
      null,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
    expect(indexedParams(fragment).map((p) => p.name)).toEqual(["to"]);
  });

  it("explains that an unnamed indexed parameter cannot be addressed", () => {
    const fragment = ethers.EventFragment.from(
      "event Mixed(address indexed, address indexed to)"
    );
    expect(err('{"arg0":"1"}', fragment)).toContain("unnamed in the ABI");
  });

  it("requires hex for an indexed bytes, which is hashed as bytes", () => {
    const fragment = ethers.EventFragment.from("event Blob(bytes indexed b)");
    expect(err('{"b":"hello"}', fragment)).toContain("0x-prefixed hex");
    const { topics } = ok('{"b":"0xabcd"}', fragment);
    expect(topics?.[1]).toBe(ethers.keccak256("0xabcd"));
  });

  it("builds the event signature plus one topic per filtered argument", () => {
    const { topics, applied } = ok(`{"from":"${ALICE}"}`, TRANSFER);
    expect(topics).toEqual([
      TRANSFER.topicHash,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
    expect(applied).toEqual(["from"]);
  });

  it("gives a non-indexed parameter no topic slot at all", () => {
    // Unlike an unnamed indexed parameter, a non-indexed one holds no topic
    // position: a filter on `who` is topic1 even though `who` is the second
    // input. Treating the filter as positional over every input would put
    // the address on the slot `amount` appears to occupy and match nothing.
    const fragment = ethers.EventFragment.from(
      "event Mixed(uint256 amount, address indexed who)"
    );
    const { topics } = ok(`{"who":"${ALICE}"}`, fragment);
    expect(topics).toEqual([
      fragment.topicHash,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
    expect(indexedParams(fragment).map((p) => p.name)).toEqual(["who"]);
  });

  it("keeps a wildcard for an earlier argument that was left empty", () => {
    // Filtering only the second indexed parameter still has to put a null in
    // the first slot, or the value would be matched against the wrong topic.
    const { topics } = ok(`{"to":"${ALICE}"}`, TRANSFER);
    expect(topics).toEqual([
      TRANSFER.topicHash,
      null,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
  });

  it("drops trailing wildcards, which say nothing", () => {
    const { topics } = ok(`{"delta":"1"}`, MIXED);
    expect(topics).toHaveLength(2);
  });

  it("encodes a negative signed value as two's complement", () => {
    // ethers' own contract.filters helper refuses this outright with
    // "unsigned value cannot be negative", which is why topics are built
    // here rather than through it.
    const { topics } = ok(`{"delta":"-5"}`, MIXED);
    expect(topics?.[1]).toBe(
      ethers.AbiCoder.defaultAbiCoder().encode(["int256"], [-5])
    );
    expect(topics?.[1]).toBe(`0x${"f".repeat(63)}b`);
  });

  it("hashes an indexed string, matching the whole value exactly", () => {
    const { topics } = ok(`{"label":"hello"}`, MIXED);
    expect(topics?.[2]).toBe(ethers.keccak256(ethers.toUtf8Bytes("hello")));
  });

  it("hashes an indexed string verbatim, whitespace included", () => {
    // The topic is keccak256 of the UTF-8 text, so " urgent" and "urgent"
    // are different values. Trimming would hash the wrong one and match
    // nothing while the step reports success.
    const { topics } = ok(`{"label":" urgent"}`, MIXED);
    expect(topics?.[2]).toBe(ethers.keccak256(ethers.toUtf8Bytes(" urgent")));
  });

  it("accepts an indexed string that is only whitespace, which is a real value", () => {
    const { topics } = ok(`{"label":"  "}`, MIXED);
    expect(topics?.[2]).toBe(ethers.keccak256(ethers.toUtf8Bytes("  ")));
  });

  it("reads a parameter named like an Object member as the user's key", () => {
    // `toString` is indexed here and left unset. An ordinary object would
    // hand back Object.prototype.toString for it and try to encode that.
    const PROTO_NAMED = ethers.EventFragment.from(
      "event Named(address indexed toString, address indexed to)"
    );
    const { topics } = ok(`{"to":"${ALICE}"}`, PROTO_NAMED);
    expect(topics).toEqual([
      PROTO_NAMED.topicHash,
      null,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
  });

  it("accepts a boolean written as text", () => {
    const { topics } = ok(`{"flag":"true"}`, MIXED);
    expect(topics?.[3]).toBe(
      ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true])
    );
  });

  it("rejects a parameter that exists but is not indexed", () => {
    expect(err(`{"value":"1"}`, TRANSFER)).toContain(
      "'value' is not an indexed parameter"
    );
  });

  it("rejects a parameter the event does not have, and names the ones it does", () => {
    const message = err(`{"sender":"1"}`, TRANSFER);
    expect(message).toContain("'sender' is not a parameter");
    expect(message).toContain("from, to");
  });

  it("rejects an indexed array, which no topic can match", () => {
    // The topic for an indexed array is a hash of the encoded contents, so
    // there is no value to compare against. ethers throws "filtering with
    // tuples or arrays not supported" at call time; this fails first, in
    // validation, naming the parameter.
    expect(err(`{"ids":"1"}`, WITH_ARRAY)).toContain("indexed uint256[]");
    expect(indexedParams(WITH_ARRAY)).toEqual([
      { name: "ids", type: "uint256[]", filterable: false, hashed: false },
      { name: "who", type: "address", filterable: true, hashed: false },
    ]);
  });

  it("rejects a negative value for an unsigned parameter", () => {
    expect(err(`{"from":"-1"}`, TRANSFER)).toContain("must be");
  });

  it("rejects a malformed address rather than querying for nothing", () => {
    expect(err(`{"from":"0x1234"}`, TRANSFER)).toContain("20-byte address");
  });

  it("rejects a filter on an event with no indexed parameters", () => {
    expect(err(`{"amount":"1"}`, UNINDEXED_ONLY)).toContain("none");
  });

  it("rejects input that is not a JSON object of single values", () => {
    expect(err("not json", TRANSFER)).toContain("not valid JSON");
    expect(err('["0x00"]', TRANSFER)).toContain("JSON object");
    expect(err('{"from":{"a":1}}', TRANSFER)).toContain("single value");
  });
});

describe("a compiled topic array through real ethers", () => {
  // The step keeps only `EventLog` instances, and ethers reaches that class
  // by a different route for a topic array than for a named event: it sets
  // `fragment = null` in getSubInfo and decodes from `topics[0]` afterwards.
  // Every other test here mocks `queryFilter`, so this is the one that would
  // notice if that chain stopped producing decoded events.
  class StubProvider extends ethers.JsonRpcProvider {
    logs: unknown[] = [];
    constructor() {
      super("http://stub.invalid", 1, { staticNetwork: true });
    }
    async send(method: string, params: unknown[]): Promise<unknown> {
      if (method === "eth_chainId") {
        return "0x1";
      }
      if (method === "eth_blockNumber") {
        return "0x10";
      }
      if (method === "eth_getLogs") {
        this.lastFilter = params[0];
        return this.logs;
      }
      throw new Error(`unexpected ${method}`);
    }
    lastFilter: unknown = null;
  }

  it("sends the topics and still returns decoded EventLogs", async () => {
    const provider = new StubProvider();
    const address = "0x2222222222222222222222222222222222222222";
    const iface = new ethers.Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    const topicsOf = (from: string, to: string) => [
      TRANSFER.topicHash,
      ethers.zeroPadValue(from, 32),
      ethers.zeroPadValue(to, 32),
    ];
    provider.logs = [
      {
        address,
        topics: topicsOf(ALICE, "0x3333333333333333333333333333333333333333"),
        data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [7]),
        blockNumber: "0x5",
        blockHash: `0x${"11".repeat(32)}`,
        transactionHash: `0x${"22".repeat(32)}`,
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
      },
    ];

    const built = buildEventArgTopics(`{"from":"${ALICE}"}`, TRANSFER);
    if (!(built.success && built.topics)) {
      throw new Error("expected a topic filter");
    }

    const contract = new ethers.Contract(address, iface, provider);
    const found = await contract.queryFilter(built.topics, 0, 16);

    expect(found).toHaveLength(1);
    expect(found[0]).toBeInstanceOf(ethers.EventLog);
    const decoded = found[0] as ethers.EventLog;
    expect(decoded.args.from).toBe(ALICE);
    expect(decoded.args.value).toBe(BigInt(7));
    expect((provider.lastFilter as { topics: unknown[] }).topics).toEqual(
      built.topics
    );
  });
});
