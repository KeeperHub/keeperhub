import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", NETWORK_RPC: "network_rpc" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

const mockGetChainIdFromNetwork = vi.fn();
const mockGetRpcProvider = vi.fn();
const mockStaticCall = vi.fn();

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

vi.mock("@/lib/contracts/multicall3", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  MULTICALL3_ABI: [
    { name: "aggregate3", type: "function", inputs: [], outputs: [] },
  ],
}));

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class MockProvider {},
      Contract: class MockContract {
        aggregate3 = { staticCall: mockStaticCall };
      },
    },
  };
});

import { ethers } from "ethers";
import { logUserError } from "@/lib/logging";
import {
  type BatchReadContractCoreInput,
  type BatchReadContractInput,
  batchReadContractStep,
} from "@/plugins/web3/steps/batch-read-contract";
import { encodeReason } from "@/plugins/web3/steps/batch-read-contract-core";

const LIST_ABI = [
  {
    name: "wrap",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "t",
        type: "tuple",
        components: [{ name: "a", type: "uint256[]" }],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "pairU",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "", type: "uint256" },
          { name: "", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "cfg",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "flag", type: "bool" },
          { name: "x", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "key",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_key", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "nested",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "m", type: "uint256[][]" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "flag",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "on", type: "bool" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "flags",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "list", type: "bool[]" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "bal",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "bal",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "who", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "blob",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "done",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "echo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "x", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "sum",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "ids", type: "uint256[]" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
const ABI = JSON.stringify(LIST_ABI);
const iface = new ethers.Interface(LIST_ABI);

// Synthetic addresses only: the last byte is the contract's number.
function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}
const CONTRACT = addr(0xc0);
const LETTERED = "0x0000000000000000000000000000000000abcdef";
const HEX_LETTER = /[a-fA-F]/g;
const ENCODE_FAILURE = /^Argument Sets entry 2 could not be encoded for echo: /;

function flipCase(c: string): string {
  return c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
}
const OWNER = addr(1);
const SPENDER = addr(2);

type Call = { target: string; callData: string };
type CallResult = { success: boolean; result: unknown; error?: string };
type Outcome = {
  success: boolean;
  results: CallResult[] | null;
  totalCalls: number | null;
  error?: string;
};

// Answers each call with something that identifies it, so order is visible:
// done() returns true, echo(x) returns x, sum(ids) the sum, allowance the
// spender's number; every call's target is recorded.
const seenTargets: string[] = [];
function answer(call: Call): [boolean, string] {
  seenTargets.push(call.target);
  const parsed = iface.parseTransaction({ data: call.callData });
  if (!parsed) {
    return [false, "0x"];
  }
  switch (parsed.name) {
    case "done":
      return [true, iface.encodeFunctionResult("done", [true])];
    case "echo":
      return [true, iface.encodeFunctionResult("echo", [parsed.args[0]])];
    case "sum": {
      const ids = parsed.args[0] as bigint[];
      const total = ids.reduce((a, b) => a + b, BigInt(0));
      return [true, iface.encodeFunctionResult("sum", [total])];
    }
    case "cfg":
      return [
        true,
        iface.encodeFunctionResult("cfg", [
          (parsed.args[0] as { flag: boolean }).flag,
        ]),
      ];
    case "pairU": {
      // Answers with the first member plus the address's last byte.
      const member = parsed.args[0] as [bigint, string];
      return [
        true,
        iface.encodeFunctionResult("pairU", [
          member[0] + BigInt(Number.parseInt(member[1].slice(-2), 16)),
        ]),
      ];
    }
    case "nested": {
      // Answers with the sum of every inner value.
      const rows = parsed.args[0] as bigint[][];
      const total = rows.flat().reduce((a, b) => a + b, BigInt(0));
      return [true, iface.encodeFunctionResult("nested", [total])];
    }
    case "wrap":
    case "key":
      return [true, iface.encodeFunctionResult(parsed.name, [BigInt(1)])];
    case "flag":
      return [true, iface.encodeFunctionResult("flag", [parsed.args[0]])];
    case "flags": {
      const list = parsed.args[0] as boolean[];
      return [true, iface.encodeFunctionResult("flags", [list.at(-1)])];
    }
    case "bal":
      // Answers with the number of arguments, so the overload used is visible.
      return [
        true,
        iface.encodeFunctionResult(parsed.fragment.format(), [
          BigInt(parsed.args.length),
        ]),
      ];
    default:
      return [
        true,
        iface.encodeFunctionResult(parsed.name, [
          BigInt(Number.parseInt((parsed.args[1] as string).slice(-2), 16)),
        ]),
      ];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  seenTargets.length = 0;
  mockGetChainIdFromNetwork.mockReturnValue(1);
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn(new (class MockProvider {})()),
  });
  mockStaticCall.mockImplementation((calls: Call[]) =>
    Promise.resolve(calls.map(answer))
  );
});

function run(overrides: Partial<BatchReadContractCoreInput>): Promise<Outcome> {
  return batchReadContractStep({
    inputMode: "uniform",
    network: "ethereum",
    abi: ABI,
    ...overrides,
  } as BatchReadContractInput) as Promise<Outcome>;
}

async function failure(
  overrides: Partial<BatchReadContractCoreInput>
): Promise<string> {
  const outcome = await run(overrides);
  expect(outcome.success).toBe(false);
  expect(mockStaticCall).not.toHaveBeenCalled();
  return outcome.error ?? "";
}

// "Fails fast" is asserted as an end state: the error, no RPC call and no
// encoding; the duration bound is only a generous backstop.
async function failureBeforeEncoding(
  overrides: Partial<BatchReadContractCoreInput>
): Promise<string> {
  const encode = vi.spyOn(ethers.Interface.prototype, "encodeFunctionData");
  const started = Date.now();
  try {
    const message = await failure(overrides);
    expect(encode).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(5000);
    return message;
  } finally {
    encode.mockRestore();
  }
}

const addressList = (
  contractAddresses: unknown,
  extra: Partial<BatchReadContractCoreInput> = {}
): Partial<BatchReadContractCoreInput> => ({
  callsFrom: "address-list",
  abiFunction: "done",
  contractAddresses:
    typeof contractAddresses === "string"
      ? contractAddresses
      : JSON.stringify(contractAddresses),
  ...extra,
});

const argsList = (
  argsFromList: unknown,
  abiFunction = "echo"
): Partial<BatchReadContractCoreInput> => ({
  callsFrom: "args-list",
  contractAddress: CONTRACT,
  abiFunction,
  argsFromList:
    typeof argsFromList === "string"
      ? argsFromList
      : JSON.stringify(argsFromList),
});

describe("batch-read-contract - contract addresses from a list", () => {
  it("calls the function on every address, in list order, duplicates kept", async () => {
    const list = [addr(3), addr(1), addr(2), addr(1)];
    const outcome = await run(addressList(list));

    expect(outcome).toEqual({
      success: true,
      totalCalls: 4,
      results: list.map(() => ({ success: true, result: true })),
    });
    expect(seenTargets).toEqual(list);
  });

  it("keeps the list order across several multicall batches", async () => {
    const list = [5, 4, 3, 2, 1].map(addr);
    const outcome = await run(addressList(list, { batchSize: "2" }));

    expect(outcome.totalCalls).toBe(5);
    expect(mockStaticCall).toHaveBeenCalledTimes(3);
    expect(seenTargets).toEqual(list);
  });

  it("sends the same arguments to every contract", async () => {
    const list = [addr(7), addr(8)];
    const outcome = await run(
      addressList(list, {
        abiFunction: "allowance",
        functionArgs: JSON.stringify([OWNER, SPENDER]),
      })
    );

    expect(outcome.results).toEqual([
      { success: true, result: "2" },
      { success: true, result: "2" },
    ]);
    expect(seenTargets).toEqual(list);
  });

  it("ignores stale arguments for a function without inputs", async () => {
    const outcome = await run(
      addressList([addr(1)], { functionArgs: JSON.stringify(["0x01"]) })
    );
    expect(outcome.success).toBe(true);
  });

  it("drops unfilled trailing inputs the editor stores as empty strings", async () => {
    const outcome = await run(
      addressList([addr(1)], {
        abiFunction: "echo",
        functionArgs: JSON.stringify(["9", ""]),
      })
    );
    expect(outcome.results).toEqual([{ success: true, result: "9" }]);
  });

  it("does not need Contract Address, and ignores hidden rows", async () => {
    const outcome = await run(
      addressList([addr(1)], {
        contractAddress: "",
        argsList: JSON.stringify([["1"], ["2"]]),
        abiFetchAddress: addr(9),
      } as Partial<BatchReadContractCoreInput>)
    );
    expect(outcome.totalCalls).toBe(1);
    expect(seenTargets).toEqual([addr(1)]);
  });

  it("accepts lower case and correctly checksummed addresses", async () => {
    const lower = "0x00000000000000000000000000000000000000ab";
    const outcome = await run(addressList([lower, ethers.getAddress(lower)]));
    expect(outcome.totalCalls).toBe(2);
  });

  it("fails on an empty list without calling the RPC", async () => {
    expect(await failure(addressList([]))).toBe(
      "Contract Addresses is empty. Check the node that produces it."
    );
  });

  it("fails when the list is not JSON", async () => {
    expect(await failure(addressList("0x01, 0x02"))).toBe(
      'Contract Addresses is not a JSON array. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like ["0xabc..."].'
    );
  });

  it("fails when the list is JSON but not an array", async () => {
    expect(await failure(addressList({ items: [addr(1)] }))).toBe(
      "Contract Addresses must be an array, got an object. Point it at the array itself, e.g. {{@node1:Label.result.items}}."
    );
  });

  it("fails when the list is blank, as an empty reference resolves", async () => {
    expect(await failure(addressList(""))).toBe(
      "Contract Addresses is empty or missing. Check the reference and the node that produces it."
    );
  });

  it("explains a single value where a list was expected", async () => {
    const single =
      "Contract Addresses got a single value, not a list. If it comes from Encode / Decode, a one-entry array comes back as a plain value; see the docs.";
    expect(await failure(addressList(addr(1)))).toBe(single);
    expect(await failure(addressList(JSON.stringify(addr(1))))).toBe(single);
    expect(await failure(argsList("7"))).toBe(
      single.replace("Contract Addresses", "Argument Sets")
    );
  });

  it("names a bad address by its position, counted from 1", async () => {
    expect(
      await failure(addressList([addr(1), addr(2), addr(3), "0x12"]))
    ).toBe(
      'Contract Addresses entry 4 is not a valid address: "0x12". Each entry must be a 0x address with 40 hex characters.'
    );
  });

  it("names an entry that is not a string", async () => {
    expect(await failure(addressList([addr(1), { a: 1 }]))).toBe(
      'Contract Addresses entry 2 must be an address string, got an object. Point the list at the addresses themselves, e.g. ["0xabc..."].'
    );
  });

  it("rejects an address with a broken checksum", async () => {
    const good = ethers.getAddress(LETTERED);
    const bad = `0x${good.slice(2).replace(HEX_LETTER, flipCase)}`;
    expect(await failure(addressList([bad]))).toBe(
      `Contract Addresses entry 1 has a bad checksum: "${bad}". Use the address exactly as published, or in all lower case.`
    );
  });

  it("caps the list at 5,000 entries", async () => {
    const list = Array.from({ length: 5001 }, (_, i) => addr(i + 1));
    expect(await failure(addressList(list))).toBe(
      "Contract Addresses has 5,001 entries; the limit is 5,000 calls per run. Filter the list first or split it across two Batch Read nodes."
    );
  });

  it("runs a list of exactly 5,000 entries", async () => {
    const list = Array.from({ length: 5000 }, (_, i) => addr(i + 1));
    const outcome = await run(addressList(list, { batchSize: "500" }));
    expect(outcome.totalCalls).toBe(5000);
  }, 30_000);

  it("caps the list text at 1 MB", async () => {
    const padded = `[${" ".repeat(2_400_000)}"${addr(1)}"]`;
    expect(await failure(addressList(padded))).toBe(
      "Contract Addresses is 2.3 MB; the limit is 1 MB. Filter the list first or split it across two Batch Read nodes."
    );
  });

  it("fails when the shared arguments are incomplete", async () => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "allowance",
          functionArgs: JSON.stringify([OWNER]),
        })
      )
    ).toBe(
      "Function Arguments has 1 value but allowance takes 2 (owner, spender). Fill in every argument; the same ones go to every contract in the list."
    );
  });

  it("is softened by Fail workflow on error off, like any read error", async () => {
    const outcome = await run(addressList([], { failOnError: false }));
    expect(outcome).toMatchObject({
      success: true,
      results: null,
      totalCalls: null,
      error: "Contract Addresses is empty. Check the node that produces it.",
    });
    expect(mockStaticCall).not.toHaveBeenCalled();
  });
});

describe("batch-read-contract - argument sets from a list", () => {
  it("makes one call per entry, in order, duplicates kept", async () => {
    const outcome = await run(argsList([["3"], ["1"], ["3"]]));
    expect(outcome).toEqual({
      success: true,
      totalCalls: 3,
      results: [
        { success: true, result: "3" },
        { success: true, result: "1" },
        { success: true, result: "3" },
      ],
    });
    expect(seenTargets).toEqual([CONTRACT, CONTRACT, CONTRACT]);
  });

  it("takes bare values for a function with one plain argument", async () => {
    const outcome = await run(argsList(["5", 6, ["7"]]));
    expect(outcome.results?.map((r) => r.result)).toEqual(["5", "6", "7"]);
  });

  it("takes several arguments per entry", async () => {
    const outcome = await run(
      argsList(
        [
          [OWNER, addr(4)],
          [OWNER, addr(5)],
        ],
        "allowance"
      )
    );
    expect(outcome.results?.map((r) => r.result)).toEqual(["4", "5"]);
  });

  it("does not unwrap an array argument: each entry is an argument set", async () => {
    const outcome = await run(argsList([[["1", "2"]], [["3"]]], "sum"));
    expect(outcome.results?.map((r) => r.result)).toEqual(["3", "3"]);
  });

  it("reads a resolved template the same way as typed JSON", async () => {
    // processTemplates writes an array-valued reference as its JSON text.
    const resolved = JSON.stringify(["8", "9"]);
    const outcome = await run(argsList(resolved));
    expect(outcome.results?.map((r) => r.result)).toEqual(["8", "9"]);
  });

  it("names an entry with the wrong number of values", async () => {
    expect(
      await failure(
        argsList([[OWNER, SPENDER], [OWNER, SPENDER], [OWNER]], "allowance")
      )
    ).toBe(
      'Argument Sets entry 3 has 1 value but allowance takes 2 (owner, spender). Make each entry an array like ["0x...", "0x..."].'
    );
  });

  it("mentions the bare value when the function takes one plain argument", async () => {
    expect(await failure(argsList([["1", "2"]]))).toBe(
      "Argument Sets entry 1 has 2 values but echo takes 1 (x). Make each entry an array like [1], or the bare value."
    );
  });

  it("names an entry that is not an array where one is needed", async () => {
    expect(
      await failure(argsList([[OWNER, SPENDER], OWNER], "allowance"))
    ).toBe(
      'Argument Sets entry 2 must be an array of 2 values for allowance (owner, spender), got a string. Make each entry an array like ["0x...", "0x..."].'
    );
  });

  it("explains that a function without arguments needs the address list", async () => {
    expect(await failure(argsList([[], []], "done"))).toBe(
      'done takes no arguments, so a list of argument sets has nothing to change between calls. To call it on many contracts, set Calls From to "A list of contract addresses".'
    );
  });

  it("names an entry that cannot be encoded", async () => {
    expect(await failure(argsList(["1", "not a number"]))).toMatch(
      ENCODE_FAILURE
    );
  });

  it("fails on an empty list without calling the RPC", async () => {
    expect(await failure(argsList([]))).toBe(
      "Argument Sets is empty. Check the node that produces it."
    );
  });

  it("fails when the list is not JSON", async () => {
    expect(await failure(argsList("1, 2"))).toBe(
      'Argument Sets is not a JSON array. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like [["0xabc..."]].'
    );
  });

  it("caps the list at 5,000 entries", async () => {
    const list = Array.from({ length: 6200 }, (_, i) => String(i));
    expect(await failure(argsList(list))).toBe(
      "Argument Sets has 6,200 entries; the limit is 5,000 calls per run. Filter the list first or split it across two Batch Read nodes."
    );
  });

  it("still needs a valid Contract Address", async () => {
    expect(await failure({ ...argsList(["1"]), contractAddress: "0x12" })).toBe(
      'Contract Address is not a valid address: "0x12". Use a 0x address with 40 hex characters.'
    );
  });

  it("ignores the hidden rows", async () => {
    const outcome = await run({
      ...argsList(["4"]),
      argsList: JSON.stringify([["1"], ["2"], ["3"]]),
    });
    expect(outcome.results).toEqual([{ success: true, result: "4" }]);
  });
});

describe("batch-read-contract - Calls From and saved workflows", () => {
  it("runs the rows when Calls From is absent, as before the field existed", async () => {
    const outcome = await run({
      contractAddress: CONTRACT,
      abiFunction: "echo",
      argsList: JSON.stringify([["1"], ["2"]]),
    });
    expect(outcome.results?.map((r) => r.result)).toEqual(["1", "2"]);
  });

  it("runs the rows and ignores hidden list fields when Calls From is rows", async () => {
    const outcome = await run({
      callsFrom: "rows",
      contractAddress: CONTRACT,
      abiFunction: "echo",
      argsList: JSON.stringify([["1"]]),
      argsFromList: JSON.stringify(["8", "9"]),
      contractAddresses: JSON.stringify([addr(1)]),
    });
    expect(outcome.results?.map((r) => r.result)).toEqual(["1"]);
    expect(seenTargets).toEqual([CONTRACT]);
  });

  it("keeps the rows' existing messages", async () => {
    const outcome = await run({
      contractAddress: CONTRACT,
      abiFunction: "echo",
      argsList: JSON.stringify(["1"]),
    });
    expect(outcome.error).toBe(
      "Args List entry at index 0 must be an array, got string"
    );
  });

  it("rejects an unknown Calls From value", async () => {
    expect(await failure({ callsFrom: "everything" })).toBe(
      'Calls From must be "rows", "args-list" or "address-list", got "everything".'
    );
  });

  it("leaves mixed mode alone", async () => {
    const outcome = await run({
      inputMode: "mixed",
      callsFrom: "address-list",
      contractAddresses: JSON.stringify([addr(1)]),
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: CONTRACT,
          abi: ABI,
          abiFunction: "echo",
          args: ["6"],
        },
      ]),
    });
    expect(outcome.results).toEqual([{ success: true, result: "6" }]);
  });
});

describe("batch-read-contract - list argument types", () => {
  it.each([
    ["true", true],
    ["false", false],
    [true, true],
    [false, false],
    [" FALSE ", false],
  ])("encodes %j as %j from Argument Sets", async (entry, expected) => {
    const outcome = await run(argsList([entry], "flag"));
    expect(outcome.results).toEqual([{ success: true, result: expected }]);
  });

  it.each([
    ["true", true],
    ["false", false],
    [true, true],
    [false, false],
  ])("encodes %j as %j from Function Arguments", async (arg, expected) => {
    const outcome = await run(
      addressList([addr(1)], {
        abiFunction: "flag",
        functionArgs: JSON.stringify([arg]),
      })
    );
    expect(outcome.results).toEqual([{ success: true, result: expected }]);
  });

  it.each([
    ["0", '"0"'],
    ["no", '"no"'],
    [1, "1"],
  ])("refuses %j for a bool in Argument Sets", async (entry, shown) => {
    expect(await failure(argsList(["true", entry], "flag"))).toBe(
      `Argument Sets entry 2: on must be true or false, got ${shown}.`
    );
  });

  it.each([
    ["0", '"0"'],
    ["no", '"no"'],
    [1, "1"],
  ])("refuses %j for a bool in Function Arguments", async (arg, shown) => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "flag",
          functionArgs: JSON.stringify([arg]),
        })
      )
    ).toBe(`Function Arguments: on must be true or false, got ${shown}.`);
  });

  it("checks bools inside an array argument", async () => {
    expect(await failure(argsList([[["true", "maybe"]]], "flags"))).toBe(
      'Argument Sets entry 1: list[1] must be true or false, got "maybe".'
    );
    const outcome = await run(argsList([[["true", "false"]]], "flags"));
    expect(outcome.results).toEqual([{ success: true, result: false }]);
  });

  it("refuses an object or null as the bare value of a one-argument function", async () => {
    expect(await failure(argsList(["1", { wallet: addr(1) }]))).toBe(
      "Argument Sets entry 2 must be a value for echo (x), got an object. Point the list at the values themselves, e.g. {{@node1:Label.result.wallets}}."
    );
    expect(await failure(argsList([null]))).toBe(
      "Argument Sets entry 1 must be a value for echo (x), got null. Point the list at the values themselves, e.g. {{@node1:Label.result.wallets}}."
    );
  });

  it("says a number must be a whole number, without ethers' details", async () => {
    const whole =
      'x must be a whole number; write large numbers in quotes, e.g. "12345678901234567890".';
    expect(await failure(argsList(["9x"]))).toBe(
      `Argument Sets entry 1 could not be encoded for echo: ${whole}`
    );
    // 79 digits: past uint256 but under the length guard.
    expect(await failure(argsList(["9".repeat(79)]))).toBe(
      `Argument Sets entry 1 could not be encoded for echo: ${whole}`
    );
  });

  it("refuses integer text longer than 80 characters before encoding", async () => {
    expect(await failure(argsList(["9".repeat(81)]))).toBe(
      "Argument Sets entry 1: x is too long for a whole number."
    );
    expect(await failure(argsList([`9${"x".repeat(500)}`]))).toBe(
      "Argument Sets entry 1: x is too long for a whole number."
    );
  });

  it("checks address arguments before encoding", async () => {
    expect(
      await failure(argsList([[OWNER, "0xnot-an-address"]], "allowance"))
    ).toBe(
      'Argument Sets entry 1: spender must be a 0x address with 40 hex characters, got "0xnot-an-address".'
    );
    const good = ethers.getAddress(LETTERED);
    const bad = `0x${good.slice(2).replace(HEX_LETTER, flipCase)}`;
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "allowance",
          functionArgs: JSON.stringify([OWNER, bad]),
        })
      )
    ).toBe(
      `Function Arguments: spender has a bad checksum: "${bad}". Use the address exactly as published, or in all lower case.`
    );
  });

  it("strips ethers' detail suffix and names the argument", () => {
    const fn = {
      name: "f",
      signature: "f(string)",
      inputs: [{ name: "label", type: "string" }],
    };
    expect(
      encodeReason(
        new Error(
          'invalid string value (argument="label", value=1, code=INVALID_ARGUMENT, version=6.17.0)'
        ),
        fn
      )
    ).toBe("label: invalid string value.");
  });

  it("names the encoder failure without a doubled full stop", async () => {
    const message = await failure(argsList(["1", "not a number"]));
    expect(message).toMatch(ENCODE_FAILURE);
    expect(message.endsWith(").") || message.endsWith("..")).toBe(false);
  });

  it("cuts a long Contract Address in its error", async () => {
    const long = `0x${"z".repeat(300)}`;
    expect(await failure({ ...argsList(["1"]), contractAddress: long })).toBe(
      `Contract Address is not a valid address: "${long.slice(0, 60)}...". Use a 0x address with 40 hex characters.`
    );
  });
});

describe("batch-read-contract - overloaded functions", () => {
  it("calls the overload picked by its signature from a list", async () => {
    const one = await run(
      addressList([addr(1)], {
        abiFunction: "bal(address)",
        functionArgs: JSON.stringify([OWNER]),
      })
    );
    expect(one.results).toEqual([{ success: true, result: "1" }]);

    const two = await run({
      callsFrom: "args-list",
      contractAddress: CONTRACT,
      abiFunction: "bal(address,uint256)",
      argsFromList: JSON.stringify([[OWNER, "5"]]),
    });
    expect(two.results).toEqual([{ success: true, result: "2" }]);
  });

  it("calls the overload picked by its signature from the rows", async () => {
    const outcome = await run({
      contractAddress: CONTRACT,
      abiFunction: "bal(address,uint256)",
      argsList: JSON.stringify([[OWNER, "5"]]),
    });
    expect(outcome.results).toEqual([{ success: true, result: "2" }]);
  });

  it("asks which overload to use for a bare overloaded name", async () => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "bal",
          functionArgs: JSON.stringify([OWNER]),
        })
      )
    ).toBe(
      "Function 'bal' matches more than one function in the ABI. Pick the one you mean in Function."
    );
  });
});

describe("batch-read-contract - list limits and shapes", () => {
  it("takes native arrays, as API and MCP callers send them", async () => {
    const byAddress = await run({
      callsFrom: "address-list",
      abiFunction: "done",
      contractAddresses: [addr(2), addr(1)],
    });
    expect(seenTargets).toEqual([addr(2), addr(1)]);
    expect(byAddress.totalCalls).toBe(2);

    const byArgs = await run({
      callsFrom: "args-list",
      contractAddress: CONTRACT,
      abiFunction: "echo",
      argsFromList: ["4", ["5"]],
      functionArgs: ["ignored"],
    });
    expect(byArgs.results?.map((r) => r.result)).toEqual(["4", "5"]);
  });

  it("applies the 1 MB cap to a native array, measured as JSON text", async () => {
    const big = [`0x${"0".repeat(1_100_000)}`];
    expect(
      await failure({
        callsFrom: "address-list",
        abiFunction: "done",
        contractAddresses: big,
      })
    ).toBe(
      "Contract Addresses is 1.1 MB; the limit is 1 MB. Filter the list first or split it across two Batch Read nodes."
    );
  });

  it("accepts exactly 1 MB of list text and refuses one byte more", async () => {
    const entry = `"${addr(1)}"`;
    const fill = (size: number): string =>
      `[${entry}${" ".repeat(size - entry.length - 2)}]`;
    const exact = fill(1_048_576);
    expect(Buffer.byteLength(exact)).toBe(1_048_576);
    // Trailing spaces are trimmed before measuring, so pad inside the array.
    expect((await run(addressList(exact))).totalCalls).toBe(1);

    mockStaticCall.mockClear();
    const over = fill(1_048_577);
    expect(await failure(addressList(over))).toBe(
      "Contract Addresses is 1.1 MB; the limit is 1 MB. Filter the list first or split it across two Batch Read nodes."
    );
  });

  it("puts Function Arguments under the same 1 MB cap", async () => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "blob",
          functionArgs: JSON.stringify([`0x${"ab".repeat(600_000)}`]),
        })
      )
    ).toBe(
      "Function Arguments is 1.2 MB; the limit is 1 MB. Use smaller arguments."
    );
  });

  it("caps the encoded call data of one run at 10 MB, before any call", async () => {
    const list = Array.from({ length: 5000 }, (_, i) => addr(i + 1));
    expect(
      await failureBeforeEncoding(
        addressList(list, {
          abiFunction: "blob",
          functionArgs: JSON.stringify([`0x${"ab".repeat(3000)}`]),
        })
      )
    ).toBe(
      "The calls' data adds up to 14.7 MB; the limit is 10 MB per run. Use smaller arguments or fewer addresses."
    );
  });

  it("encodes shared arguments once for every address", async () => {
    const encode = vi.spyOn(ethers.Interface.prototype, "encodeFunctionData");
    await run(
      addressList([addr(1), addr(2), addr(3)], {
        abiFunction: "echo",
        functionArgs: JSON.stringify(["1"]),
      })
    );
    expect(encode).toHaveBeenCalledTimes(1);
    encode.mockRestore();
  });

  it("accepts an address with spaces around it", async () => {
    const outcome = await run(addressList([` ${addr(5)} `]));
    expect(seenTargets).toEqual([addr(5)]);
    expect(outcome.totalCalls).toBe(1);
  });

  it("runs the rows when Calls From is an empty string", async () => {
    const outcome = await run({
      callsFrom: "",
      contractAddress: CONTRACT,
      abiFunction: "echo",
      argsList: JSON.stringify([["3"]]),
    });
    expect(outcome.results).toEqual([{ success: true, result: "3" }]);
  });

  it("does not use Function or Contract Address jargon from the rows", async () => {
    expect(await failure({ ...argsList(["1"]), contractAddress: "" })).toBe(
      "Contract Address is required. Enter the contract to call."
    );
    expect(await failure({ ...argsList(["1"]), abiFunction: "" })).toBe(
      "Function is required. Pick one in Function."
    );
  });

  it("shows a tuple argument as {...} in the example entry", async () => {
    const abi = JSON.stringify([
      {
        name: "pair",
        type: "function",
        stateMutability: "view",
        inputs: [
          {
            name: "key",
            type: "tuple",
            components: [{ name: "a", type: "uint256" }],
          },
          { name: "n", type: "uint256" },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
    expect(await failure({ ...argsList([[{ a: "1" }]], "pair"), abi })).toBe(
      'Argument Sets entry 1 has 1 value but pair takes 2 (key, n). Make each entry an array like [{"a": 1}, 1].'
    );
  });
});

describe("batch-read-contract - review round 2", () => {
  it("caps one call at about 64 KB before encoding a huge uint256[] (fails fast, no RPC)", async () => {
    for (const length of [300_000, 520_000]) {
      const zeros = `[[[${Array.from({ length }, () => "0").join(",")}]]]`;
      expect(Buffer.byteLength(zeros)).toBeLessThan(1_048_576);
      const message = await failureBeforeEncoding(argsList(zeros, "sum"));
      expect(message).toMatch(
        /^Argument Sets entry 1 is about [\d,]+ KB of call data; the limit is 64 KB per call\. Use smaller arguments\.$/
      );
    }
  });

  it("caps one call before encoding a huge uint256[][] of empty arrays", async () => {
    const empties = `[[[${Array.from({ length: 260_000 }, () => "[]").join(",")}]]]`;
    expect(Buffer.byteLength(empties)).toBeLessThan(1_048_576);
    const message = await failureBeforeEncoding(argsList(empties, "nested"));
    expect(message).toMatch(/^Argument Sets entry 1 is about [\d,]+ KB/);
  });

  it("caps the shared Function Arguments at about 64 KB", async () => {
    const message = await failureBeforeEncoding(
      addressList([addr(1)], {
        abiFunction: "sum",
        functionArgs: `[[${Array.from({ length: 400_000 }, () => "0").join(",")}]]`,
      })
    );
    expect(message).toMatch(
      /^Function Arguments is about [\d,]+ KB of call data; the limit is 64 KB per call\. Use smaller arguments\.$/
    );
  });

  it("caps a run at 50,000 values: 50,001 fails fast, 50,000 runs", async () => {
    const tenZeros = `[[${Array.from({ length: 9 }, () => "0").join(",")}]]`;
    const elevenZeros = `[[${Array.from({ length: 10 }, () => "0").join(",")}]]`;
    const over = `[${[...Array.from({ length: 4999 }, () => tenZeros), elevenZeros].join(",")}]`;
    expect(await failureBeforeEncoding(argsList(over, "sum"))).toBe(
      "The calls add up to 50,001 values; the limit is 50,000 per run. Use fewer or smaller entries."
    );

    // A plain revert per call keeps the mock out of the timing.
    mockStaticCall.mockImplementation((calls: Call[]) =>
      Promise.resolve(calls.map(() => [false, "0x"]))
    );
    const exact = `[${Array.from({ length: 5000 }, () => tenZeros).join(",")}]`;
    const outcome = await run({ ...argsList(exact, "sum"), batchSize: "500" });
    expect(outcome.totalCalls).toBe(5000);
  }, 30_000);

  it("runs 5,000 getAddress-style bytes32 lookups", async () => {
    const keys = Array.from(
      { length: 5000 },
      (_, i) => `0x${i.toString(16).padStart(64, "0")}`
    );
    const outcome = await run({ ...argsList(keys, "key"), batchSize: "500" });
    expect(outcome.totalCalls).toBe(5000);
  }, 30_000);

  it("cuts a failed multicall's message and log, which carry the call data", async () => {
    mockStaticCall.mockRejectedValueOnce(
      new Error(
        `call failed (transaction={ "data": "0x${"ab".repeat(200_000)}" })`
      )
    );
    const outcome = await run(addressList([addr(1)]));
    expect(outcome.success).toBe(false);
    expect(outcome.error?.length).toBeLessThan(300);
    const logged = vi
      .mocked(logUserError)
      .mock.calls.find(([, message]) =>
        String(message).includes("Multicall batch")
      );
    expect(String(logged?.[1]).length).toBeLessThan(400);
    // The error keeps its type for the structured log; only the text is cut.
    const loggedError = logged?.[2] as Error;
    expect(loggedError).toBeInstanceOf(Error);
    expect(loggedError.name).toBe("Error");
    expect(loggedError.message.length).toBeLessThan(260);
  });

  it("cuts a long revert reason", async () => {
    const reason = "r".repeat(5000);
    const data = `0x08c379a0${ethers.AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2)}`;
    mockStaticCall.mockResolvedValueOnce([[false, data]]);
    const outcome = await run(addressList([addr(1)]));
    const error = outcome.results?.[0].error ?? "";
    expect(error.startsWith("Call reverted: ")).toBe(true);
    expect(error.length).toBeLessThan(260);
  });

  it("checks a bool inside a tuple", async () => {
    expect(await failure(argsList([[{ flag: "no", x: "1" }]], "cfg"))).toBe(
      'Argument Sets entry 1: p.flag must be true or false, got "no".'
    );
    const outcome = await run(argsList([[{ flag: "false", x: "1" }]], "cfg"));
    expect(outcome.results).toEqual([{ success: true, result: false }]);
  });

  it("reads a tuple written as a positional array", async () => {
    const outcome = await run(
      argsList([[["false", "1"]], [["true", "2"]]], "cfg")
    );
    expect(outcome.results?.map((r) => r.result)).toEqual([false, true]);
    mockStaticCall.mockClear();
    expect(await failure(argsList([[["false"]]], "cfg"))).toBe(
      "Argument Sets entry 1: p has 1 value but its tuple takes 2 (flag, x). Give one value per member, in order."
    );
  });

  it("checks a bytes32 argument before encoding", async () => {
    expect(await failure(argsList(["MCD_VAT"], "key"))).toBe(
      'Argument Sets entry 1: _key must be 0x hex for bytes32, got "MCD_VAT". Turn text into bytes32 with the Encode / Decode node first.'
    );
    expect(await failure(argsList(["0x1234"], "key"))).toContain(
      "_key must be 0x hex for bytes32"
    );
    const outcome = await run(argsList([`0x${"0".repeat(62)}01`], "key"));
    expect(outcome.results).toEqual([{ success: true, result: "1" }]);
  });

  it("trims spaces around address arguments", async () => {
    const outcome = await run(
      argsList([[` ${OWNER} `, ` ${addr(9)}`]], "allowance")
    );
    expect(outcome.results).toEqual([{ success: true, result: "9" }]);
  });

  it("shows a Calls From object as JSON", async () => {
    expect(await failure({ callsFrom: { a: 1 } as unknown as string })).toBe(
      'Calls From must be "rows", "args-list" or "address-list", got {"a":1}.'
    );
  });

  it("names Network and Contract ABI without mode jargon, with a next step", async () => {
    expect(await failure({ ...argsList(["1"]), network: "" })).toBe(
      "Network is required. Pick one in Network."
    );
    expect(await failure({ ...argsList(["1"]), abi: "" })).toBe(
      "Contract ABI is required. Enter Contract Address to fetch it, or tick Use manual ABI and paste it."
    );
    expect(await failure({ ...addressList([addr(1)]), abi: "" })).toBe(
      "Contract ABI is required. Enter an address in Fetch ABI From to fetch it, or tick Use manual ABI and paste it."
    );
  });

  it("says a missing function is not in the ABI, with a next step", async () => {
    expect(await failure(addressList([addr(1)], { abiFunction: "nope" }))).toBe(
      "Function 'nope' is not in the ABI. Pick it again in Function, or check the ABI."
    );
  });

  it("calls the overload picked by its signature in mixed mode", async () => {
    const outcome = await run({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: CONTRACT,
          abi: ABI,
          abiFunction: "bal(address,uint256)",
          args: [OWNER, "5"],
        },
        {
          network: "ethereum",
          contractAddress: CONTRACT,
          abi: ABI,
          abiFunction: "bal(address)",
          args: [OWNER],
        },
      ]),
    });
    expect(outcome.results).toEqual([
      { success: true, result: "2" },
      { success: true, result: "1" },
    ]);
  });
});

describe("batch-read-contract - review round 3", () => {
  const bigArrayText = `[${Array.from({ length: 450_000 }, () => "0").join(",")}]`;

  it("parses a tuple's array held as text, then caps it, fast and without RPC", async () => {
    expect(
      await failureBeforeEncoding(
        argsList(JSON.stringify([[[bigArrayText]]]), "wrap")
      )
    ).toMatch(
      /^Argument Sets entry 1 is about [\d,]+ KB of call data; the limit is 64 KB per call\. Use smaller arguments\.$/
    );
    expect(
      await failureBeforeEncoding(
        addressList([addr(1)], {
          abiFunction: "wrap",
          functionArgs: JSON.stringify([[bigArrayText]]),
        })
      )
    ).toMatch(/^Function Arguments is about [\d,]+ KB of call data/);
  });

  it("refuses a top-level tuple held as text", async () => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "wrap",
          functionArgs: JSON.stringify([JSON.stringify({ a: [0, 0] })]),
        })
      )
    ).toBe(
      "Function Arguments: t must be an array or object for its tuple (a), got text. Give the value as a JSON array, not as text holding one."
    );
  });

  it("takes editor-shaped Function Arguments for a uint256[][] parameter", async () => {
    // The editor stores each inner array as its JSON text.
    const outcome = await run(
      addressList([addr(1), addr(2)], {
        abiFunction: "nested",
        functionArgs: JSON.stringify([["[1,2]", "[3]"]]),
      })
    );
    expect(outcome.results).toEqual([
      { success: true, result: "6" },
      { success: true, result: "6" },
    ]);
  });

  it("refuses inner text that is not a JSON array", async () => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "nested",
          functionArgs: JSON.stringify([["oops"]]),
        })
      )
    ).toBe(
      "Function Arguments: m[0] must be an array for uint256[], got text that is not a JSON array."
    );
    expect(await failure(argsList([[["[1,"]]], "nested"))).toBe(
      "Argument Sets entry 1: m[0] must be an array for uint256[], got text that is not a JSON array."
    );
  });

  it("counts values parsed from inner text toward the 50,000 cap", async () => {
    const inner = JSON.stringify(Array.from({ length: 1500 }, () => 0));
    const list = `[${Array.from({ length: 40 }, () => JSON.stringify([[inner]])).join(",")}]`;
    expect(await failureBeforeEncoding(argsList(list, "nested"))).toMatch(
      /^The calls add up to [\d,]+ values; the limit is 50,000 per run\. Use fewer or smaller entries\.$/
    );
  });

  it("refuses a primitive where an array type is expected", async () => {
    expect(await failure(argsList([["5"]], "sum"))).toBe(
      "Argument Sets entry 1: ids must be an array for uint256[], got text. Give the value as a JSON array, not as text holding one."
    );
  });

  it("keeps a tuple with unnamed members positional", async () => {
    const outcome = await run(
      argsList([[["5", addr(1)]], [[7, addr(2)]]], "pairU")
    );
    expect(outcome.results?.map((r) => r.result)).toEqual(["6", "9"]);
    mockStaticCall.mockClear();
    expect(await failure(argsList([[["5"]]], "pairU"))).toBe(
      "Argument Sets entry 1: p has 1 value but its tuple takes 2 (uint256, address). Give one value per member, in order."
    );
    expect(await failure(argsList([[["5", "0x12"]]], "pairU"))).toBe(
      'Argument Sets entry 1: p.1 must be a 0x address with 40 hex characters, got "0x12".'
    );
  });

  it("refuses an object for a tuple with unnamed members", async () => {
    expect(await failure(argsList([[{ a: "5", b: addr(1) }]], "pairU"))).toBe(
      "Argument Sets entry 1: p takes its values in order for its tuple (uint256, address); give an array."
    );
  });

  it("shows tuple members in the example entry", async () => {
    expect(await failure(argsList(["x"], "cfg"))).toBe(
      'Argument Sets entry 1 must be an array of 1 value for cfg (p), got a string. Make each entry an array like [{"flag": true, "x": 1}].'
    );
    expect(await failure(argsList(["x"], "pairU"))).toBe(
      'Argument Sets entry 1 must be an array of 1 value for pairU (p), got a string. Make each entry an array like [[1, "0x..."]].'
    );
  });

  it("cuts the example entry for a very wide tuple", async () => {
    const components = Array.from({ length: 100 }, (_, i) => ({
      name: `member${i}`,
      type: "uint256",
    }));
    const abi = JSON.stringify([
      {
        name: "wide",
        type: "function",
        stateMutability: "view",
        inputs: [
          { name: "w", type: "tuple", components },
          { name: "n", type: "uint256" },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
    const message = await failure({ ...argsList(["x"], "wide"), abi });
    expect(message).toMatch(
      /^Argument Sets entry 1 must be an array of 2 values for wide \(w, n\), got a string\. Make each entry an array like \[\{"member0": 1, .*\.\.\.\.$/
    );
    expect(message.length).toBeLessThan(400);
  });

  it("names a bad address in a mixed call like the other modes", async () => {
    const outcome = await run({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: `0x${"z".repeat(300)}`,
          abi: ABI,
          abiFunction: "echo",
          args: ["1"],
        },
      ]),
    });
    expect(outcome.error).toBe(
      `Call 1: Contract Address is not a valid address: "0x${"z".repeat(58)}...". Use a 0x address with 40 hex characters.`
    );
  });

  it("checks the address list before the shared Function Arguments", async () => {
    expect(
      await failure(
        addressList(["0x12"], {
          abiFunction: "allowance",
          functionArgs: JSON.stringify([OWNER]),
        })
      )
    ).toBe(
      'Contract Addresses entry 1 is not a valid address: "0x12". Each entry must be a 0x address with 40 hex characters.'
    );
  });

  it("trims Contract Address and names a bad checksum on it", async () => {
    const outcome = await run({
      ...argsList(["1"]),
      contractAddress: ` ${CONTRACT} `,
    });
    expect(seenTargets).toEqual([CONTRACT]);
    expect(outcome.totalCalls).toBe(1);
    mockStaticCall.mockClear();
    const good = ethers.getAddress(LETTERED);
    const bad = `0x${good.slice(2).replace(HEX_LETTER, flipCase)}`;
    expect(await failure({ ...argsList(["1"]), contractAddress: bad })).toBe(
      `Contract Address has a bad checksum: "${bad}". Use the address exactly as published, or in all lower case.`
    );
  });

  it("reports a missing or empty argument", async () => {
    expect(await failure(argsList([[OWNER, ""]], "allowance"))).toBe(
      "Argument Sets entry 1: spender cannot be empty (address)."
    );
    expect(await failure(argsList([[{ flag: true }]], "cfg"))).toBe(
      "Argument Sets entry 1: p.x is missing (uint256)."
    );
  });
});
