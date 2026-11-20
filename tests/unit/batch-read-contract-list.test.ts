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
  isSolanaChain: (chainId: number) => chainId === 101 || chainId === 103,
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
    name: "trio",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "xs", type: "uint256[3]" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "tagged",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "who", type: "address" },
      { name: "tag", type: "string" },
    ],
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
  destinationError?: true;
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
    case "tagged":
      // Answers with the tag's length, so an empty tag reads as 0.
      return [
        true,
        iface.encodeFunctionResult("tagged", [
          BigInt((parsed.args[1] as string).length),
        ]),
      ];
    case "wrap":
    case "trio":
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
      "Contract Addresses is missing: the field is blank or its reference resolved to nothing. Check the reference and the node that produces it."
    );
  });

  it("explains a single value where a list was expected", async () => {
    const single =
      'Contract Addresses got a single value, not a list. To give one, put it in brackets, like ["0xabc..."]. If it comes from Encode / Decode, a one-entry array comes back as a plain value; see the docs.';
    expect(await failure(addressList(addr(1)))).toBe(single);
    expect(await failure(addressList(JSON.stringify(addr(1))))).toBe(single);
    expect(await failure(argsList("7"))).toBe(
      single
        .replace("Contract Addresses", "Argument Sets")
        .replace('["0xabc..."]', "[[1]]")
    );
  });

  it("names a bad address by its position, counted from 1", async () => {
    expect(
      await failure(addressList([addr(1), addr(2), addr(3), "0x12"]))
    ).toBe(
      'Contract Addresses entry 4 is not a valid address: "0x12". Use a 0x address with 40 hex characters.'
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
      "Contract Addresses has 5,001 entries; the limit is 5,000 addresses per node. Filter the list first or split it across several nodes."
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
      "Contract Addresses is 2.3 MB; the limit is 1 MB. Filter the list first or split it across several nodes."
    );
  });

  it("fails when a shared argument that is not a string is left blank", async () => {
    // The editor leaves an untouched input out, or stores it as "".
    for (const functionArgs of [[OWNER], [OWNER, ""]]) {
      expect(
        await failure(
          addressList([addr(1)], {
            abiFunction: "allowance",
            functionArgs: JSON.stringify(functionArgs),
          })
        )
      ).toBe(
        "Function Arguments: spender: address cannot be empty. Fill in every argument; only a string may be left blank."
      );
    }
  });

  it("fails when the shared arguments have values left over", async () => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "allowance",
          functionArgs: JSON.stringify([OWNER, addr(9), "1"]),
        })
      )
    ).toBe(
      "Function Arguments has 3 values, but allowance takes 2 (owner, spender). The same arguments go to every contract in the list."
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
      'Argument Sets entry 3 has 1 value, but allowance takes 2 (owner, spender). Make each entry an array like ["0x...", "0x..."].'
    );
  });

  it("mentions the bare value when the function takes one plain argument", async () => {
    expect(await failure(argsList([["1", "2"]]))).toBe(
      "Argument Sets entry 1 has 2 values, but echo takes 1 (x). Make each entry an array like [1], or the bare value."
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
    expect(await failure(argsList(["1", "-1"]))).toMatch(ENCODE_FAILURE);
  });

  it("fails on an empty list without calling the RPC", async () => {
    expect(await failure(argsList([]))).toBe(
      "Argument Sets is empty. Check the node that produces it."
    );
  });

  it("fails when the list is not JSON", async () => {
    expect(await failure(argsList("1, 2"))).toBe(
      "Argument Sets is not a JSON array. Reference an array from an earlier node, e.g. {{@node1:Label.result}}, or type one like [[1]]."
    );
  });

  it("caps the list at 5,000 entries", async () => {
    const list = Array.from({ length: 6200 }, (_, i) => String(i));
    expect(await failure(argsList(list))).toBe(
      "Argument Sets has 6,200 entries; the limit is 5,000 calls per run. Filter the list first or split it across several nodes."
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
      `Argument Sets entry 2: on must be true or false, got ${shown}. Use true or false.`
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
    ).toBe(
      `Function Arguments: on must be true or false, got ${shown}. Use true or false.`
    );
  });

  it("checks bools inside an array argument", async () => {
    expect(await failure(argsList([[["true", "maybe"]]], "flags"))).toBe(
      'Argument Sets entry 1: list[1] must be true or false, got "maybe". Use true or false.'
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
    expect(await failure(argsList(["9x"]))).toBe(
      'Argument Sets entry 1: x must be a whole number in digits, got "9x".'
    );
    // 79 digits: past uint256 but under the length guard.
    const range =
      "x is out of range for uint256, which cannot be negative and has a maximum.";
    expect(await failure(argsList(["9".repeat(79)]))).toBe(
      `Argument Sets entry 1 could not be encoded for echo: ${range}`
    );
    expect(await failure(argsList(["-1"]))).toBe(
      `Argument Sets entry 1 could not be encoded for echo: ${range}`
    );
  });

  it("refuses integer text longer than 260 characters before encoding", async () => {
    expect(await failure(argsList(["9".repeat(261)]))).toBe(
      "Argument Sets entry 1: x is too long for a whole number. Write it in at most 78 digits, with no spaces around it."
    );
    // Padding counts: the encoder would parse all of it.
    expect(await failure(argsList([`${" ".repeat(300)}5`]))).toBe(
      "Argument Sets entry 1: x is too long for a whole number. Write it in at most 78 digits, with no spaces around it."
    );
    expect(await failure(argsList([`9${"x".repeat(500)}`]))).toBe(
      "Argument Sets entry 1: x is too long for a whole number. Write it in at most 78 digits, with no spaces around it."
    );
  });

  it("checks address arguments before encoding", async () => {
    expect(
      await failure(argsList([[OWNER, "0xnot-an-address"]], "allowance"))
    ).toBe(
      'Argument Sets entry 1: spender is not a valid address: "0xnot-an-address". Use a 0x address with 40 hex characters.'
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
    const message = await failure(argsList(["1", "-1"]));
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
      "Contract Addresses is 1.1 MB; the limit is 1 MB. Filter the list first or split it across several nodes."
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
      "Contract Addresses is 1.1 MB; the limit is 1 MB. Filter the list first or split it across several nodes."
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
      'Argument Sets entry 1 has 1 value, but pair takes 2 (key, n). Make each entry an array like [{"a": 1}, 1].'
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
        /^Argument Sets entry 1 has more than 64 KB of call data, the limit per call\. Use smaller arguments\.$/
      );
    }
  });

  it("caps one call before encoding a huge uint256[][] of empty arrays", async () => {
    const empties = `[[[${Array.from({ length: 260_000 }, () => "[]").join(",")}]]]`;
    expect(Buffer.byteLength(empties)).toBeLessThan(1_048_576);
    const message = await failureBeforeEncoding(argsList(empties, "nested"));
    expect(message).toMatch(/^Argument Sets entry 1 has more than 64 KB/);
  });

  it("caps the shared Function Arguments at about 64 KB", async () => {
    const message = await failureBeforeEncoding(
      addressList([addr(1)], {
        abiFunction: "sum",
        functionArgs: `[[${Array.from({ length: 400_000 }, () => "0").join(",")}]]`,
      })
    );
    expect(message).toMatch(
      /^Function Arguments has more than 64 KB of call data, the limit per call\. Use smaller arguments\.$/
    );
  });

  it("caps a run at 50,000 values: 50,001 fails fast, 50,000 runs", async () => {
    const tenZeros = `[[${Array.from({ length: 9 }, () => "0").join(",")}]]`;
    const elevenZeros = `[[${Array.from({ length: 10 }, () => "0").join(",")}]]`;
    const over = `[${[...Array.from({ length: 4999 }, () => tenZeros), elevenZeros].join(",")}]`;
    expect(await failureBeforeEncoding(argsList(over, "sum"))).toBe(
      "The calls hold more than 50,000 values, the limit per run. Use fewer entries or smaller arguments."
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
      'Argument Sets entry 1: p.flag must be true or false, got "no". Use true or false.'
    );
    const outcome = await run(argsList([[{ flag: "false", x: "1" }]], "cfg"));
    expect(outcome.results).toEqual([{ success: true, result: false }]);
  });

  it("reads a tuple as Read Contract does: by member name, or flat", async () => {
    const outcome = await run(
      argsList([[{ flag: "false", x: "1" }], ["true", "2"]], "cfg")
    );
    expect(outcome.results?.map((r) => r.result)).toEqual([false, true]);
    mockStaticCall.mockClear();
    expect(await failure(argsList([[["false", "1"]]], "cfg"))).toBe(
      'Argument Sets entry 1: give p as an object with its member names, like {"flag": true, "x": 1}, not as an array.'
    );
    expect(await failure(argsList([["false"]], "cfg"))).toBe(
      'Argument Sets entry 1: p must be an object with its member names, like {"flag": true, "x": 1}, got "false". Or give its 2 members flat in its place.'
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

  it("refuses spaces around an address argument, as the encoder would", async () => {
    expect(
      await failure(argsList([[` ${OWNER} `, addr(9)]], "allowance"))
    ).toBe(
      `Argument Sets entry 1: owner is not a valid address: " ${OWNER} ". Remove the spaces around it.`
    );
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
        argsList(JSON.stringify([[{ a: bigArrayText }]]), "wrap")
      )
    ).toMatch(
      /^Argument Sets entry 1 has more than 64 KB of call data, the limit per call\. Use smaller arguments\.$/
    );
    expect(
      await failureBeforeEncoding(
        addressList([addr(1)], {
          abiFunction: "wrap",
          functionArgs: JSON.stringify([{ a: bigArrayText }]),
        })
      )
    ).toMatch(/^Function Arguments has more than 64 KB of call data/);
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
      'Function Arguments: give t as an object with its member names, like {"a": [1, 1]}, not as text.'
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
      "Function Arguments: m[0]: expected array for uint256[]. Check the arguments for nested (m)."
    );
    expect(await failure(argsList([[["[1,"]]], "nested"))).toBe(
      "Argument Sets entry 1: m[0]: expected array for uint256[]. An entry for nested looks like [[[1, 1], [1, 1]]]."
    );
  });

  it("counts values parsed from inner text toward the 50,000 cap", async () => {
    const inner = JSON.stringify(Array.from({ length: 1500 }, () => 0));
    const list = `[${Array.from({ length: 40 }, () => JSON.stringify([[inner]])).join(",")}]`;
    expect(await failureBeforeEncoding(argsList(list, "nested"))).toMatch(
      /^The calls hold more than 50,000 values, the limit per run\. Use fewer entries or smaller arguments\.$/
    );
  });

  it("refuses a primitive where an array type is expected", async () => {
    expect(await failure(argsList([["5"]], "sum"))).toBe(
      "Argument Sets entry 1: ids: expected array for uint256[]. An entry for sum looks like [[1, 1]]."
    );
  });

  it("names a tuple with unnamed members, which cannot be given by name", async () => {
    const message =
      "pairU takes a tuple with unnamed members (p). Tuple values are given by member name, so Batch Read cannot fill this one.";
    expect(await failure(argsList([[["5", addr(1)]]], "pairU"))).toBe(message);
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "pairU",
          functionArgs: JSON.stringify([{ a: "5" }]),
        })
      )
    ).toBe(message);
  });

  it("shows tuple members in the example entry", async () => {
    expect(await failure(argsList(["x"], "cfg"))).toBe(
      'Argument Sets entry 1 must be an array of 1 value for cfg (p), got a string. Make each entry an array like [{"flag": true, "x": 1}].'
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
      'Contract Addresses entry 1 is not a valid address: "0x12". Use a 0x address with 40 hex characters.'
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
      'Argument Sets entry 1: spender: address cannot be empty. An entry for allowance looks like ["0x...", "0x..."].'
    );
    expect(await failure(argsList([[{ flag: true }]], "cfg"))).toBe(
      'Argument Sets entry 1: p.x: uint256 is missing. An entry for cfg looks like [{"flag": true, "x": 1}].'
    );
  });
});

describe("batch-read-contract - review fixes", () => {
  it("sends an empty final string argument, whether left blank or untouched", async () => {
    for (const functionArgs of [[OWNER, ""], [OWNER]]) {
      const outcome = await run(
        addressList([addr(1)], {
          abiFunction: "tagged",
          functionArgs: JSON.stringify(functionArgs),
        })
      );
      expect(outcome.results).toEqual([{ success: true, result: "0" }]);
    }
    mockStaticCall.mockClear();
    const outcome = await run(argsList([[OWNER, ""]], "tagged"));
    expect(outcome.results).toEqual([{ success: true, result: "0" }]);
  });

  it("takes a tuple given as flat values in Function Arguments, as Read Contract does", async () => {
    const outcome = await run(
      addressList([addr(1)], {
        abiFunction: "cfg",
        functionArgs: JSON.stringify(["true", "1"]),
      })
    );
    expect(outcome.results).toEqual([{ success: true, result: true }]);
  });

  it("encodes and decodes by the fragment resolved once, not by signature per call", async () => {
    const encode = vi.spyOn(ethers.Interface.prototype, "encodeFunctionData");
    const decode = vi.spyOn(ethers.Interface.prototype, "decodeFunctionResult");
    try {
      const args = Array.from({ length: 50 }, (_, i) => String(i));
      const runs = [
        argsList(args),
        addressList(Array.from({ length: 50 }, (_, i) => addr(i + 1))),
        {
          contractAddress: CONTRACT,
          abiFunction: "echo",
          argsList: JSON.stringify(args.map((a) => [a])),
        },
      ];
      for (const config of runs) {
        encode.mockClear();
        decode.mockClear();
        expect((await run(config)).totalCalls).toBe(50);
        const used = [...encode.mock.calls, ...decode.mock.calls].map(
          (c) => c[0]
        );
        expect(used.length).toBeGreaterThan(0);
        expect(
          used.every((key) => key instanceof ethers.FunctionFragment)
        ).toBe(true);
        expect(new Set(used).size).toBe(1);
      }
    } finally {
      encode.mockRestore();
      decode.mockRestore();
    }
  });

  describe("with Fail workflow on error off, where the calls go still fails the run", () => {
    const cases: [string, Partial<BatchReadContractCoreInput>, string][] = [
      [
        "a missing Network",
        { ...argsList(["1"]), network: "" },
        "Network is required. Pick one in Network.",
      ],
      [
        "a bad Contract Address in rows mode",
        { contractAddress: "0x12", abiFunction: "echo", argsList: '[["1"]]' },
        'Contract Address is not a valid address: "0x12". Use a 0x address with 40 hex characters.',
      ],
      [
        "a missing Contract Address with a list of argument sets",
        { ...argsList(["1"]), contractAddress: "" },
        "Contract Address is required. Enter the contract to call.",
      ],
      [
        "a bad entry in Contract Addresses",
        addressList([addr(1), "0x12"]),
        'Contract Addresses entry 2 is not a valid address: "0x12". Use a 0x address with 40 hex characters.',
      ],
      [
        "a blank Contract Addresses",
        addressList(""),
        "Contract Addresses is missing: the field is blank or its reference resolved to nothing. Check the reference and the node that produces it.",
      ],
      [
        "a Contract Addresses that is not a list",
        addressList({ a: 1 }),
        "Contract Addresses must be an array, got an object. Point it at the array itself, e.g. {{@node1:Label.result.items}}.",
      ],
      [
        "a bad address in a Different contracts call",
        {
          inputMode: "mixed",
          calls: JSON.stringify([
            {
              network: "ethereum",
              contractAddress: "0x12",
              abi: ABI,
              abiFunction: "echo",
              args: ["1"],
            },
          ]),
        },
        'Call 1: Contract Address is not a valid address: "0x12". Use a 0x address with 40 hex characters.',
      ],
      [
        "a Contract Addresses entry without 0x",
        addressList([addr(1), addr(2).slice(2)]),
        `Contract Addresses entry 2 has no 0x in front: "${addr(2).slice(2)}". Write it as 0x followed by the 40 hex characters; if the source leaves 0x off every address, add it in an earlier node.`,
      ],
      [
        "a Contract Addresses over 5,000 entries",
        addressList(Array.from({ length: 5001 }, (_, i) => addr(i + 1))),
        "Contract Addresses has 5,001 entries; the limit is 5,000 addresses per node. Filter the list first or split it across several nodes.",
      ],
      [
        "a Contract Addresses over 1 MB",
        addressList(`[${" ".repeat(1_100_000)}"${addr(1)}"]`),
        "Contract Addresses is 1.1 MB; the limit is 1 MB. Filter the list first or split it across several nodes.",
      ],
      [
        "a missing network in a Different contracts call",
        {
          inputMode: "mixed",
          calls: JSON.stringify([
            {
              contractAddress: CONTRACT,
              abi: ABI,
              abiFunction: "echo",
              args: ["1"],
            },
          ]),
        },
        "Call 1 has no network. Pick one for this call.",
      ],
    ];
    for (const [name, config, message] of cases) {
      it(name, async () => {
        const outcome = await run({ ...config, failOnError: false });
        expect(outcome).toEqual({
          success: false,
          destinationError: true,
          error: message,
        });
        expect(mockStaticCall).not.toHaveBeenCalled();
      });
    }

    it("a Solana network, named before its addresses are read", async () => {
      mockGetChainIdFromNetwork.mockReturnValue(101);
      const outcome = await run({
        ...addressList(["So11111111111111111111111111111111111111112"]),
        failOnError: false,
      });
      expect(outcome).toEqual({
        success: false,
        destinationError: true,
        error:
          "Solana is not supported for this action yet. Pick an EVM network in Network.",
      });
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
    });

    it("a Solana network with a list of argument sets or rows", async () => {
      mockGetChainIdFromNetwork.mockReturnValue(103);
      const refused = {
        success: false,
        destinationError: true,
        error:
          "Solana is not supported for this action yet. Pick an EVM network in Network.",
      };
      expect
        .soft(await run({ ...argsList([["1"]]), failOnError: false }))
        .toEqual(refused);
      expect
        .soft(
          await run({
            contractAddress: CONTRACT,
            abiFunction: "echo",
            calls: JSON.stringify([{ args: ["1"] }]),
            failOnError: false,
          })
        )
        .toEqual(refused);
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
    });

    it("a Solana network in a Different contracts call", async () => {
      mockGetChainIdFromNetwork.mockImplementation((network: string) =>
        network === "solana" ? 101 : 1
      );
      const outcome = await run({
        inputMode: "mixed",
        failOnError: false,
        calls: JSON.stringify([
          {
            network: "ethereum",
            contractAddress: CONTRACT,
            abi: ABI,
            abiFunction: "echo",
            args: ["1"],
          },
          {
            network: "solana",
            contractAddress: CONTRACT,
            abi: ABI,
            abiFunction: "echo",
            args: ["1"],
          },
        ]),
      });
      expect(outcome).toEqual({
        success: false,
        destinationError: true,
        error:
          "Call 2: Solana is not supported for this action yet. Pick an EVM network for this call.",
      });
      expect(mockStaticCall).not.toHaveBeenCalled();
    });

    it("but an empty Contract Addresses list is passed on as a soft error", async () => {
      const outcome = await run(addressList([], { failOnError: false }));
      expect(outcome).toEqual({
        success: true,
        results: null,
        totalCalls: null,
        error: "Contract Addresses is empty. Check the node that produces it.",
      });
    });

    it("and a bad Argument Sets entry too", async () => {
      const outcome = await run({
        ...argsList([[OWNER, "0x12"]], "allowance"),
        failOnError: false,
      });
      expect(outcome.success).toBe(true);
      expect(outcome.results).toBeNull();
    });
  });

  it("trims Contract Address in rows mode, as in the list modes", async () => {
    const outcome = await run({
      contractAddress: ` ${CONTRACT} `,
      abiFunction: "echo",
      argsList: '[["1"]]',
    });
    expect(outcome.totalCalls).toBe(1);
    expect(seenTargets).toEqual([CONTRACT]);
  });

  it("logs every check that fails before a call as a validation error", async () => {
    const configs: Partial<BatchReadContractCoreInput>[] = [
      { ...argsList(["1"]), callsFrom: "addresses" },
      { ...argsList(["1"]), abi: "" },
      { ...argsList(["1"]), network: "" },
      { inputMode: "mixed", calls: "[]" },
    ];
    for (const config of configs) {
      vi.mocked(logUserError).mockClear();
      const outcome = await run(config);
      expect(outcome.success).toBe(false);
      expect(vi.mocked(logUserError)).toHaveBeenCalledWith(
        "validation",
        `[Batch Read Contract] ${outcome.error}`,
        undefined,
        { plugin_name: "web3", action_name: "batch-read-contract" }
      );
    }
  });
});

describe("batch-read-contract - review fixes, round 2", () => {
  const WIDE_ABI = JSON.stringify([
    {
      name: "wide",
      type: "function",
      stateMutability: "view",
      inputs: [
        {
          name: "xs",
          type: "tuple[]",
          components: Array.from({ length: 900 }, (_, i) => ({
            name: `m${i}`,
            type: "uint256",
          })),
        },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
  ]);
  const empties = (n: number): string =>
    `[${Array.from({ length: n }, () => "{}").join(",")}]`;

  it("stops a wide tuple times many items at the cap, before coercing it", async () => {
    const message = await failureBeforeEncoding({
      ...argsList(`[[${empties(50_000)}]]`, "wide"),
      abi: WIDE_ABI,
    });
    expect(message).toBe(
      "Argument Sets entry 1 has more than 64 KB of call data, the limit per call. Use smaller arguments."
    );
    expect(
      await failureBeforeEncoding({
        ...addressList([addr(1)], {
          abiFunction: "wide",
          functionArgs: `[${empties(50_000)}]`,
        }),
        abi: WIDE_ABI,
      })
    ).toBe(
      "Function Arguments has more than 64 KB of call data, the limit per call. Use smaller arguments."
    );
  });

  it("refuses a function that declares more than 1,000 parameters and members", async () => {
    const abi = JSON.stringify([
      {
        name: "huge",
        type: "function",
        stateMutability: "view",
        inputs: [
          {
            name: "x",
            type: "tuple",
            components: Array.from({ length: 1000 }, (_, i) => ({
              name: `m${i}`,
              type: "uint256",
            })),
          },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
    const message =
      "huge declares 1,001 parameters and tuple members; a list can call a function with up to 1,000.";
    expect(await failure({ ...argsList([[{}]], "huge"), abi })).toBe(message);
    expect(
      await failure({
        ...addressList([addr(1)], {
          abiFunction: "huge",
          functionArgs: "[{}]",
        }),
        abi,
      })
    ).toBe(message);
  });

  it("fails the run for a call that is not an object, wherever it sits", async () => {
    const outcome = await run({
      inputMode: "mixed",
      failOnError: false,
      calls: JSON.stringify([
        null,
        {
          contractAddress: CONTRACT,
          abi: ABI,
          abiFunction: "echo",
          args: ["1"],
        },
      ]),
    });
    expect(outcome).toEqual({
      success: false,
      destinationError: true,
      error:
        "Call 1 must be an object with its network, contract, ABI and function.",
    });
  });

  it("checks the 5,000-call limit in mixed mode before any call", async () => {
    const call = {
      network: "ethereum",
      contractAddress: CONTRACT,
      abi: ABI,
      abiFunction: "echo",
      args: ["1"],
    };
    const isAddress = vi.spyOn(ethers, "isAddress");
    try {
      expect(
        await failure({
          inputMode: "mixed",
          calls: JSON.stringify(Array.from({ length: 5001 }, () => call)),
        })
      ).toBe("Too many calls (5001). Maximum is 5000.");
      expect(isAddress).not.toHaveBeenCalled();
    } finally {
      isAddress.mockRestore();
    }
  });

  it("names a tuple given as JSON text", async () => {
    expect(
      await failure(argsList([[JSON.stringify({ flag: true, x: "1" })]], "cfg"))
    ).toBe(
      'Argument Sets entry 1: give p as an object with its member names, like {"flag": true, "x": 1}, not as text.'
    );
  });

  it("accepts a Contract Address without 0x where Read Contract does", async () => {
    const bare = CONTRACT.slice(2);
    expect(
      (
        await run({
          contractAddress: bare,
          abiFunction: "echo",
          argsList: '[["1"]]',
        })
      ).totalCalls
    ).toBe(1);
    mockStaticCall.mockClear();
    const mixed = await run({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: bare,
          abi: ABI,
          abiFunction: "echo",
          args: ["1"],
        },
      ]),
    });
    expect(mixed.totalCalls).toBe(1);
  });

  it("fails the run for a bad mixed call address wherever it sits in the list", async () => {
    const outcome = await run({
      inputMode: "mixed",
      failOnError: false,
      calls: JSON.stringify([
        { network: "ethereum", contractAddress: CONTRACT, abi: ABI, args: [] },
        {
          network: "ethereum",
          contractAddress: "0x12",
          abi: ABI,
          abiFunction: "echo",
          args: ["1"],
        },
      ]),
    });
    expect(outcome).toEqual({
      success: false,
      destinationError: true,
      error:
        'Call 2: Contract Address is not a valid address: "0x12". Use a 0x address with 40 hex characters.',
    });
  });

  it("checks a fixed-size array's length before encoding", async () => {
    expect(
      await failureBeforeEncoding(
        addressList([addr(1)], {
          abiFunction: "trio",
          functionArgs: JSON.stringify(["[1,2]"]),
        })
      )
    ).toBe(
      "Function Arguments: xs: uint256[3] takes 3 items, got 2. Check the arguments for trio (xs)."
    );
    const outcome = await run(argsList([["[1,2,3]"]], "trio"));
    expect(outcome.results).toEqual([{ success: true, result: "1" }]);
  });

  it("counts a hex-looking string at its full length", async () => {
    expect(
      await failureBeforeEncoding(
        argsList([[OWNER, `0x${"ab".repeat(40_000)}`]], "tagged")
      )
    ).toBe(
      "Argument Sets entry 1 has more than 64 KB of call data, the limit per call. Use smaller arguments."
    );
  });

  it("hints at an object for a tuple given as an array in Function Arguments", async () => {
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "cfg",
          functionArgs: JSON.stringify([["true", "1"]]),
        })
      )
    ).toBe(
      'Function Arguments: give p as an object with its member names, like {"flag": true, "x": 1}, not as an array.'
    );
  });
});

describe("batch-read-contract - review fixes, round 3", () => {
  const abiWith = (name: string, inputs: unknown[]): string =>
    JSON.stringify([
      {
        name,
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);

  it("keeps the example short for deeply nested arrays", async () => {
    const abi = abiWith("deep", [
      { name: "a", type: `uint256${"[3]".repeat(20)}` },
      { name: "b", type: "uint256" },
    ]);
    const message = await failure({ ...argsList([5], "deep"), abi });
    expect(message).toBe(
      "Argument Sets entry 1 must be an array of 2 values for deep (a, b), got a number. Make each entry an array like [[[[...], [...], [...]], [[...], [...], [...]], [[...], [...], [...]]], 1]."
    );
  });

  it("names the tuple member and its type when a number is out of range", async () => {
    const abi = abiWith("small", [
      { name: "p", type: "tuple", components: [{ name: "a", type: "uint8" }] },
      { name: "k", type: "int8" },
    ]);
    expect(
      await failure({ ...argsList([[{ a: "300" }, "1"]], "small"), abi })
    ).toBe(
      "Argument Sets entry 1 could not be encoded for small: p.a is out of range for uint8. Use a whole number from 0 to 255."
    );
    mockStaticCall.mockClear();
    expect(
      await failure({ ...argsList([[{ a: "1" }, "-200"]], "small"), abi })
    ).toBe(
      "Argument Sets entry 1 could not be encoded for small: k is out of range for int8. Use a whole number from -128 to 127."
    );
  });

  it("gives a short flat tuple entry the count message, not the object hint", async () => {
    const abi = abiWith("flat", [
      {
        name: "t",
        type: "tuple",
        components: [
          { name: "a", type: "uint256" },
          { name: "b", type: "uint256" },
        ],
      },
      { name: "x", type: "uint256" },
    ]);
    // t may be given flat with x missing, so the count names both readings.
    expect(await failure({ ...argsList([[1, 2]], "flat"), abi })).toBe(
      'Argument Sets entry 1 has 2 values for flat (t, x), which takes 2 when t is an object, or 3 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1].'
    );
  });
});

describe("batch-read-contract - review fixes, round 4", () => {
  const abiWith = (name: string, inputs: unknown[]): string =>
    JSON.stringify([
      {
        name,
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);

  it("names nothing when a tuple member shares a top-level input's name", async () => {
    const abi = abiWith("twin", [
      {
        name: "p",
        type: "tuple",
        components: [{ name: "a", type: "uint256" }],
      },
      { name: "a", type: "uint8" },
    ]);
    const message =
      "Argument Sets entry 1 could not be encoded for twin: a value is out of range for its type. Check that each number fits its type in the ABI.";
    expect(
      await failure({ ...argsList([[{ a: "1" }, "300"]], "twin"), abi })
    ).toBe(message);
    mockStaticCall.mockClear();
    const swapped = abiWith("twin", [
      { name: "p", type: "tuple", components: [{ name: "a", type: "uint8" }] },
      { name: "a", type: "uint256" },
    ]);
    expect(
      await failure({
        ...argsList([[{ a: "300" }, "1"]], "twin"),
        abi: swapped,
      })
    ).toBe(message);
  });

  it("names nothing when only nested members share the name", async () => {
    const abi = abiWith("pair", [
      { name: "p", type: "tuple", components: [{ name: "a", type: "uint8" }] },
      { name: "q", type: "tuple", components: [{ name: "a", type: "uint8" }] },
    ]);
    expect(
      await failure({ ...argsList([[{ a: "1" }, { a: "300" }]], "pair"), abi })
    ).toBe(
      "Argument Sets entry 1 could not be encoded for pair: a value is out of range for its type. Check that each number fits its type in the ABI."
    );
  });

  it("uses the only input's item type for an array item out of range", async () => {
    const abi = abiWith("items", [{ name: "xs", type: "uint8[]" }]);
    expect(await failure({ ...argsList([[["1", "300"]]], "items"), abi })).toBe(
      "Argument Sets entry 1 could not be encoded for items: xs is out of range for uint8. Use a whole number from 0 to 255."
    );
  });

  it("shows member names in the example for an array of tuples", async () => {
    const abi = abiWith("orders", [
      {
        name: "os",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "ids", type: "uint256[]" },
        ],
      },
      { name: "n", type: "uint256" },
    ]);
    expect(await failure({ ...argsList(["x"], "orders"), abi })).toBe(
      'Argument Sets entry 1 must be an array of 2 values for orders (os, n), got a string. Make each entry an array like [[{"target": "0x...", "ids": [...]}, {"target": "0x...", "ids": [...]}], 1].'
    );
  });
});

describe("batch-read-contract - out-of-range wording by width", () => {
  const abiOf = (type: string): string =>
    JSON.stringify([
      {
        name: "w",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "v", type }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);

  it("gives the range up to 64 bits and the limits wording above", async () => {
    expect(
      await failure({
        ...argsList(["18446744073709551616"], "w"),
        abi: abiOf("uint64"),
      })
    ).toBe(
      "Argument Sets entry 1 could not be encoded for w: v is out of range for uint64. Use a whole number from 0 to 18446744073709551615."
    );
    mockStaticCall.mockClear();
    expect(
      await failure({
        ...argsList([`1${"0".repeat(39)}`], "w"),
        abi: abiOf("int128"),
      })
    ).toBe(
      "Argument Sets entry 1 could not be encoded for w: v is out of range for int128, which has a minimum and a maximum."
    );
  });
});

describe("batch-read-contract - positional tuple hint length", () => {
  it("cuts a wide tuple's example to 200 characters", async () => {
    const abi = JSON.stringify([
      {
        name: "broad",
        type: "function",
        stateMutability: "view",
        inputs: [
          {
            name: "t",
            type: "tuple",
            components: Array.from({ length: 50 }, (_, i) => ({
              name: `m${i}`,
              type: "uint256",
            })),
          },
          { name: "x", type: "uint256" },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
    const message = await failure({
      // One item per member: the array is read as the whole tuple.
      ...argsList([[Array.from({ length: 50 }, () => "1"), "3"]], "broad"),
      abi,
    });
    const prefix =
      "Argument Sets entry 1: give t as an object with its member names, like ";
    const suffix = ", not as an array.";
    expect(message.startsWith(prefix)).toBe(true);
    expect(message.endsWith(`...${suffix}`)).toBe(true);
    expect(message.length - prefix.length - suffix.length).toBe(203);
  });
});

describe("batch-read-contract - second review", () => {
  const abiWith = (name: string, inputs: unknown[]): string =>
    JSON.stringify([
      {
        name,
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);

  it("reads text members of a flat tuple as members, not as the tuple", async () => {
    const abi = abiWith("flat", [
      {
        name: "t",
        type: "tuple",
        components: [
          { name: "a", type: "uint256" },
          { name: "b", type: "uint256" },
        ],
      },
      { name: "x", type: "uint256" },
    ]);
    expect(await failure({ ...argsList([["1", "2"]], "flat"), abi })).toBe(
      'Argument Sets entry 1 has 2 values for flat (t, x), which takes 2 when t is an object, or 3 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1].'
    );
    mockStaticCall.mockClear();
    expect(
      (await run({ ...argsList([["1", "2", "3"]], "flat"), abi })).totalCalls
    ).toBe(1);
  });

  it('sends a blank string member of a flat tuple in Function Arguments as ""', async () => {
    const abi = abiWith("g", [
      {
        name: "t",
        type: "tuple",
        components: [
          { name: "a", type: "uint256" },
          { name: "s", type: "string" },
        ],
      },
    ]);
    for (const functionArgs of [["1", ""], ["1"], [{ a: "1", s: "" }]]) {
      mockStaticCall.mockClear();
      const outcome = await run({
        ...addressList([addr(1)], {
          abiFunction: "g",
          functionArgs: JSON.stringify(functionArgs),
        }),
        abi,
      });
      expect(outcome.totalCalls, JSON.stringify(functionArgs)).toBe(1);
    }
  });

  it("asks for quotes for a JSON number past 2^53, and a whole number for a fraction", async () => {
    const abi = abiWith("bal", [{ name: "id", type: "uint256" }]);
    expect(
      await failure({ ...argsList("[12345678901234567890]", "bal"), abi })
    ).toBe(
      'Argument Sets entry 1: id has too many digits to send as a number and may have lost some. Write it in quotes, like "12345678901234567890", or have the earlier node send it as text.'
    );
    expect(await failure({ ...argsList("[1.5]", "bal"), abi })).toBe(
      "Argument Sets entry 1: id must be a whole number, got 1.5."
    );
    mockStaticCall.mockClear();
    expect(
      (await run({ ...argsList('["12345678901234567890"]', "bal"), abi }))
        .totalCalls
    ).toBe(1);
  });
});

describe("batch-read-contract - second review, round 2", () => {
  const abiWith = (name: string, inputs: unknown[]): string =>
    JSON.stringify([
      {
        name,
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
  const arrayFirst = abiWith("g", [
    {
      name: "t",
      type: "tuple",
      components: [
        { name: "xs", type: "uint256[]" },
        { name: "s", type: "string" },
      ],
    },
  ]);

  it("reads an array first member of a flat tuple as that member", async () => {
    for (const functionArgs of [
      ["[1,2]", ""],
      [[1, 2], ""],
      ["[1,2]"],
      ["[1,2]", "x"],
    ]) {
      mockStaticCall.mockClear();
      const outcome = await run({
        ...addressList([addr(1)], {
          abiFunction: "g",
          functionArgs: JSON.stringify(functionArgs),
        }),
        abi: arrayFirst,
      });
      expect(outcome.totalCalls, JSON.stringify(functionArgs)).toBe(1);
    }
    mockStaticCall.mockClear();
    expect(
      await failure({ ...argsList([["[1,2]"]], "g"), abi: arrayFirst })
    ).toBe(
      'Argument Sets entry 1: t must be an object with its member names, like {"xs": [1, 1], "s": "..."}, got "[1,2]". Or give its 2 members flat in its place.'
    );
  });

  it("reads JSON text in a string first member as that member", async () => {
    const abi = abiWith("h", [
      {
        name: "t",
        type: "tuple",
        components: [
          { name: "s", type: "string" },
          { name: "n", type: "string" },
        ],
      },
    ]);
    mockStaticCall.mockClear();
    const outcome = await run({
      ...addressList([addr(1)], {
        abiFunction: "h",
        functionArgs: JSON.stringify(['{"k":1}', ""]),
      }),
      abi,
    });
    expect(outcome.totalCalls).toBe(1);
  });

  it("still names a tuple given as JSON object text", async () => {
    expect(
      await failure({
        ...argsList([[JSON.stringify({ xs: [1], s: "a" })]], "g"),
        abi: arrayFirst,
      })
    ).toBe(
      'Argument Sets entry 1: give t as an object with its member names, like {"xs": [1, 1], "s": "..."}, not as text.'
    );
  });

  it("asks for quotes for a negative number past 2^53 too", async () => {
    const abi = abiWith("signed", [{ name: "v", type: "int256" }]);
    expect(
      await failure({ ...argsList("[-12345678901234567890]", "signed"), abi })
    ).toContain(
      'v has too many digits to send as a number and may have lost some. Write it in quotes, like "-12345678901234567890"'
    );
  });

  const pairs = abiWith("two", [
    {
      name: "t",
      type: "tuple",
      components: [
        { name: "a", type: "uint256" },
        { name: "b", type: "uint256" },
      ],
    },
    {
      name: "v",
      type: "tuple",
      components: [
        { name: "c", type: "uint256" },
        { name: "d", type: "uint256" },
      ],
    },
    { name: "x", type: "uint256" },
    { name: "y", type: "uint256" },
  ]);

  it("walks past a tuple given flat to name the next one", async () => {
    expect(
      await failure({ ...argsList([[1, 2, [1, 2], 3, 4]], "two"), abi: pairs })
    ).toBe(
      'Argument Sets entry 1: give v as an object with its member names, like {"c": 1, "d": 1}, not as an array.'
    );
    expect(
      await failure({
        ...argsList([[1, 2, '{"c":1,"d":2}', 3, 4]], "two"),
        abi: pairs,
      })
    ).toBe(
      'Argument Sets entry 1: give v as an object with its member names, like {"c": 1, "d": 1}, not as text.'
    );
  });

  it("names a tuple slot only when its members could not be given flat", async () => {
    // v may be given flat with y missing: the count names both readings.
    expect(
      await failure({
        ...argsList([[{ a: 1, b: 2 }, "1", 3, 4]], "two"),
        abi: pairs,
      })
    ).toBe(
      'Argument Sets entry 1 has 4 values for two (t, v, x, y), which takes 4 when v is an object, or 5 when v is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, {"c": 1, "d": 1}, 1, 1].'
    );
    // Both tuple places hold plain values.
    expect(
      await failure({
        ...argsList([[1, 2, { c: 1, d: 2 }, 3]], "two"),
        abi: pairs,
      })
    ).toBe(
      'Argument Sets entry 1 has 4 values for two (t, v, x, y), which takes 4 when t is an object, or 5 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, {"c": 1, "d": 1}, 1, 1].'
    );
    // Fewer values than inputs: the count message, not the slot.
    expect(
      await failure({
        ...argsList([[{ a: 1, b: 2 }, "1", 3]], "two"),
        abi: pairs,
      })
    ).toBe(
      'Argument Sets entry 1 has 3 values for two (t, v, x, y), which takes 4 when v is an object, or 5 when v is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, {"c": 1, "d": 1}, 1, 1].'
    );
  });

  const pair = {
    type: "tuple",
    components: [
      { name: "a", type: "uint256" },
      { name: "b", type: "uint256" },
    ],
  };
  const uint = (name: string): { name: string; type: string } => ({
    name,
    type: "uint256",
  });

  // The review's example: t given flat and y missing reads the same as t
  // holding a plain value, so the message must not blame t.
  it("does not blame a tuple given flat when a value is missing", async () => {
    const after = abiWith("f", [{ name: "t", ...pair }, uint("x"), uint("y")]);
    expect(await failure({ ...argsList([[1, 2, 3]], "f"), abi: after })).toBe(
      'Argument Sets entry 1 has 3 values for f (t, x, y), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1, 1].'
    );
    // The value missing may come before the tuple too.
    const before = abiWith("g", [uint("x"), uint("y"), { name: "t", ...pair }]);
    expect(await failure({ ...argsList([[1, 5, 6]], "g"), abi: before })).toBe(
      'Argument Sets entry 1 has 3 values for g (x, y, t), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [1, 1, {"a": 1, "b": 1}].'
    );
    const last = abiWith("h", [uint("x"), { name: "t", ...pair }]);
    expect(await failure({ ...argsList([[1, 5]], "h"), abi: last })).toBe(
      'Argument Sets entry 1 has 2 values for h (x, t), which takes 2 when t is an object, or 3 when t is given flat as its 2 members. Make each entry an array like [1, {"a": 1, "b": 1}].'
    );
  });

  it("names a tuple slot when no flat reading of it lines up", async () => {
    const alone = abiWith("f", [{ name: "t", ...pair }]);
    expect(await failure({ ...argsList([[5]], "f"), abi: alone })).toBe(
      'Argument Sets entry 1: t must be an object with its member names, like {"a": 1, "b": 1}, got 5. Or give its 2 members flat in its place.'
    );
    // An object next to it is another tuple's value, not one of its members.
    const both = abiWith("g", [
      { name: "t", ...pair },
      { name: "u", ...pair },
    ]);
    expect(
      await failure({ ...argsList([[1, { a: 1, b: 2 }]], "g"), abi: both })
    ).toBe(
      'Argument Sets entry 1: t must be an object with its member names, like {"a": 1, "b": 1}, got 1. Or give its 2 members flat in its place.'
    );
    expect(
      await failure({ ...argsList([[{ a: 1, b: 2 }, 5]], "g"), abi: both })
    ).toBe(
      'Argument Sets entry 1: u must be an object with its member names, like {"a": 1, "b": 1}, got 5. Or give its 2 members flat in its place.'
    );
  });

  it("names every tuple the values read as flat in the count", async () => {
    const three = abiWith("f", [
      { name: "t", ...pair },
      { name: "u", ...pair },
      { name: "w", ...pair },
    ]);
    expect(
      await failure({ ...argsList([[1, 2, 3, 4, 5]], "f"), abi: three })
    ).toBe(
      'Argument Sets entry 1 has 5 values for f (t, u, w), which takes 3 when t, u and w are objects, or 6 when they are given flat as their members. Make each entry an array like [{"a": 1, "b": 1}, {"a": 1, "b": 1}, {"a": 1, "b": 1}].'
    );
  });

  // A member that is a tuple takes an object, so an object there may be it.
  it("does not blame a tuple given flat whose later member is a tuple", async () => {
    const t = {
      name: "t",
      type: "tuple",
      components: [uint("b"), { name: "s", ...pair }],
    };
    const after = abiWith("f", [t, uint("x")]);
    expect(
      await failure({ ...argsList([[1, { a: 1, b: 2 }]], "f"), abi: after })
    ).toBe(
      'Argument Sets entry 1 has 2 values for f (t, x), which takes 2 when t is an object, or 3 when t is given flat as its 2 members. Make each entry an array like [{"b": 1, "s": {"a": 1, "b": 1}}, 1].'
    );
    // Values missing before it: x and y, with t given flat as (5, {...}, 7).
    const wide = { ...t, components: [...t.components, uint("c")] };
    const before = abiWith("g", [uint("x"), uint("y"), wide]);
    expect(
      await failure({ ...argsList([[5, { a: 1, b: 2 }, 7]], "g"), abi: before })
    ).toBe(
      'Argument Sets entry 1 has 3 values for g (x, y, t), which takes 3 when t is an object, or 5 when t is given flat as its 3 members. Make each entry an array like [1, 1, {"b": 1, "s": {"a": 1, "b": 1}, "c": 1}].'
    );
  });

  it("counts only tuples whose flat reading takes more values", async () => {
    // One member reads the same either way.
    const one = abiWith("f", [
      { name: "t", type: "tuple", components: [uint("a")] },
      uint("x"),
      uint("y"),
    ]);
    expect(await failure({ ...argsList([[1, 2]], "f"), abi: one })).toBe(
      'Argument Sets entry 1 has 2 values, but f takes 3 (t, x, y). Make each entry an array like [{"a": 1}, 1, 1].'
    );
    // No values left for it: not read as flat.
    const end = abiWith("g", [uint("x"), { name: "t", ...pair }]);
    expect(await failure({ ...argsList([[1]], "g"), abi: end })).toBe(
      'Argument Sets entry 1 has 1 value, but g takes 2 (x, t). Make each entry an array like [1, {"a": 1, "b": 1}].'
    );
    const mid = abiWith("h", [
      { name: "t", ...pair },
      uint("x"),
      { name: "u", ...pair },
    ]);
    expect(await failure({ ...argsList([[1, 2]], "h"), abi: mid })).toBe(
      'Argument Sets entry 1 has 2 values for h (t, x, u), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1, {"a": 1, "b": 1}].'
    );
  });

  it("does not blame a one-member tuple when an object lands on a plain input", async () => {
    // A one-member tuple given flat already lines up; the two-member u is offered.
    const single = { name: "t", type: "tuple", components: [uint("a")] };
    const first = abiWith("f", [single, uint("x"), { name: "u", ...pair }]);
    expect(
      await failure({ ...argsList([[1, { c: 1 }, 3]], "f"), abi: first })
    ).toBe(
      'Argument Sets entry 1 has 3 values for f (t, x, u), which takes 3 when u is an object, or 4 when u is given flat as its 2 members. Make each entry an array like [{"a": 1}, 1, {"a": 1, "b": 1}].'
    );
    const middle = abiWith("g", [single, { name: "u", ...pair }, uint("x")]);
    expect(
      await failure({ ...argsList([[1, 2, { c: 1 }]], "g"), abi: middle })
    ).toBe(
      'Argument Sets entry 1: x must be a whole number, got {"c":1}. Only a tuple takes an object.'
    );
    const late = abiWith("h", [uint("x"), single, { name: "u", ...pair }]);
    expect(
      await failure({ ...argsList([[{ c: 1 }, 2, 3]], "h"), abi: late })
    ).toBe(
      'Argument Sets entry 1 has 3 values for h (x, t, u), which takes 3 when u is an object, or 4 when u is given flat as its 2 members. Make each entry an array like [1, {"a": 1}, {"a": 1, "b": 1}].'
    );
  });

  it("gives the count when a value is missing before a tuple given flat", async () => {
    // x missing, t flat as (1, 2), then u's object: no t blame.
    const after = abiWith("f", [
      uint("x"),
      { name: "t", ...pair },
      { name: "u", ...pair },
    ]);
    expect(
      await failure({ ...argsList([[1, 2, { a: 1, b: 2 }]], "f"), abi: after })
    ).toBe(
      'Argument Sets entry 1 has 3 values for f (x, t, u), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [1, {"a": 1, "b": 1}, {"a": 1, "b": 1}].'
    );
  });

  it("counts a tuple read flat when an object lands on its tuple member", async () => {
    const inner = abiWith("g", [
      {
        name: "t",
        type: "tuple",
        components: [
          uint("a"),
          { name: "b", type: "tuple", components: [uint("c")] },
        ],
      },
      uint("x"),
      uint("y"),
    ]);
    expect(
      await failure({ ...argsList([[1, { c: 1 }, 2, 3, 4]], "g"), abi: inner })
    ).toBe(
      'Argument Sets entry 1 has 5 values for g (t, x, y), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": {"c": 1}}, 1, 1].'
    );
  });

  it("counts the tuples read flat before an object on a plain input", async () => {
    const blocked = abiWith("h", [{ name: "t", ...pair }, uint("x")]);
    expect(
      await failure({ ...argsList([[1, 2, { z: 1 }, 4]], "h"), abi: blocked })
    ).toBe(
      'Argument Sets entry 1 has 4 values for h (t, x), which takes 2 when t is an object, or 3 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1].'
    );
    // The object need not be on the last input.
    const middle = abiWith("g", [{ name: "t", ...pair }, uint("x"), uint("y")]);
    expect
      .soft(
        await failure({
          ...argsList([[1, 2, { z: 1 }, 4, 5]], "g"),
          abi: middle,
        })
      )
      .toBe(
        'Argument Sets entry 1 has 5 values for g (t, x, y), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1, 1].'
      );
  });

  it("lists every tuple read flat when the values match the inputs", async () => {
    const abi = abiWith("f", [
      { name: "t", ...pair },
      { name: "u", ...pair },
      uint("x"),
      uint("y"),
    ]);
    expect
      .soft(await failure({ ...argsList([[1, 2, 3, 4]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1 has 4 values for f (t, u, x, y), which takes 4 when t and u are objects, or 6 when they are given flat as their members. Make each entry an array like [{"a": 1, "b": 1}, {"a": 1, "b": 1}, 1, 1].'
      );
  });

  it("names neither of two tuples starting with a tuple when both hold a plain value", async () => {
    const nested = {
      type: "tuple",
      components: [
        { name: "i", type: "tuple", components: [uint("p")] },
        uint("c"),
      ],
    };
    const twoNested = abiWith("k", [
      { name: "o", ...nested },
      { name: "n", ...nested },
    ]);
    // Neither lines up with the other still holding a plain value.
    expect(await failure({ ...argsList([[1, 2]], "k"), abi: twoNested })).toBe(
      'Argument Sets entry 1 has 2 values for k (o, n), the right number, but not in the right places. Make each entry an array like [{"i": {"p": 1}, "c": 1}, {"i": {"p": 1}, "c": 1}].'
    );
  });

  it("names two flat tuples and a three-member one", async () => {
    const two = abiWith("f", [
      { name: "t", ...pair },
      { name: "u", ...pair },
      uint("x"),
    ]);
    expect(
      await failure({ ...argsList([[1, 2, 3, 4, 5, 6]], "f"), abi: two })
    ).toBe(
      'Argument Sets entry 1 has 6 values for f (t, u, x), which takes 3 when t and u are objects, or 5 when they are given flat as their members. Make each entry an array like [{"a": 1, "b": 1}, {"a": 1, "b": 1}, 1].'
    );
    // Values missing on both sides of a three-member tuple.
    const wide = abiWith("g", [
      uint("x"),
      {
        name: "t",
        type: "tuple",
        components: [uint("a"), uint("b"), uint("c")],
      },
      uint("y"),
    ]);
    expect(await failure({ ...argsList([[5, 1, 2]], "g"), abi: wide })).toBe(
      'Argument Sets entry 1 has 3 values for g (x, t, y), which takes 3 when t is an object, or 5 when t is given flat as its 3 members. Make each entry an array like [1, {"a": 1, "b": 1, "c": 1}, 1].'
    );
  });

  it("names an unnamed tuple by its place", async () => {
    const abi = abiWith("f", [{ name: "", ...pair }, uint("x"), uint("y")]);
    expect(await failure({ ...argsList([[1, 2, 3]], "f"), abi })).toBe(
      'Argument Sets entry 1 has 3 values for f (arg0, x, y), which takes 3 when arg0 is an object, or 4 when arg0 is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1, 1].'
    );
  });

  const nestedO = {
    name: "o",
    type: "tuple",
    components: [{ name: "inner", ...pair }, uint("id")],
  };

  it("names a tuple starting with a tuple only when the entry lines up", async () => {
    const valid = abiWith("f", [nestedO, uint("x")]);
    const ok = await run({
      ...argsList([[{ inner: { a: 1, b: 2 }, id: 3 }, 4]], "f"),
      abi: valid,
    });
    expect(ok.success).toBe(true);
    const [call] = mockStaticCall.mock.calls[0][0] as Call[];
    expect(
      new ethers.Interface(valid)
        .decodeFunctionData("f", call.callData)
        .toArray()
    ).toEqual([[[BigInt(1), BigInt(2)], BigInt(3)], BigInt(4)]);
    mockStaticCall.mockClear();
    // x missing: the object is o's, so the count, not o, is given.
    const middle = abiWith("g", [uint("x"), nestedO, uint("y")]);
    expect(
      await failure({
        ...argsList([[{ inner: { a: 1, b: 2 }, id: 3 }, 4]], "g"),
        abi: middle,
      })
    ).toBe(
      'Argument Sets entry 1 has 2 values, but g takes 3 (x, o, y). Make each entry an array like [1, {"inner": {"a": 1, "b": 1}, "id": 1}, 1].'
    );
    // Too short to reach it.
    const last = abiWith("h", [uint("x"), nestedO]);
    expect(await failure({ ...argsList([[1]], "h"), abi: last })).toBe(
      'Argument Sets entry 1 has 1 value, but h takes 2 (x, o). Make each entry an array like [1, {"inner": {"a": 1, "b": 1}, "id": 1}].'
    );
    // After a tuple given flat, o sits after its members.
    const after = abiWith("k", [{ name: "t", ...pair }, nestedO]);
    expect(await failure({ ...argsList([[1, 2, 3]], "k"), abi: after })).toBe(
      'Argument Sets entry 1: o must be an object with its member names, like {"inner": {"a": 1, "b": 1}, "id": 1}, got 3.'
    );
    expect(
      await failure({ ...argsList([[1, 2, '{"inner":1}']], "k"), abi: after })
    ).toBe(
      'Argument Sets entry 1: give o as an object with its member names, like {"inner": {"a": 1, "b": 1}, "id": 1}, not as text.'
    );
    const unnamed = abiWith("m", [{ ...nestedO, name: "" }, uint("x")]);
    expect(await failure({ ...argsList([[1, 2]], "m"), abi: unnamed })).toBe(
      'Argument Sets entry 1: arg0 must be an object with its member names, like {"inner": {"a": 1, "b": 1}, "id": 1}, got 1.'
    );
  });

  it("counts a tuple member's place as one an object can take", async () => {
    const inner = abiWith("f", [
      {
        name: "t",
        type: "tuple",
        components: [
          uint("a"),
          { name: "m", type: "tuple", components: [uint("c"), uint("d")] },
        ],
      },
      uint("x"),
      uint("y"),
      uint("z"),
    ]);
    expect
      .soft(
        await failure({
          ...argsList([[1, { c: 1, d: 2 }, { z: 1 }]], "f"),
          abi: inner,
        })
      )
      .toBe(
        'Argument Sets entry 1: x must be a whole number, got {"z":1}. Only a tuple takes an object.'
      );
    // A tuple starting with a tuple takes an object only in its own place.
    const nested = abiWith("g", [
      {
        name: "o",
        type: "tuple",
        components: [
          { name: "m", type: "tuple", components: [uint("c"), uint("d")] },
          { name: "n", type: "tuple", components: [uint("e"), uint("f")] },
        ],
      },
      uint("x"),
      uint("y"),
    ]);
    expect
      .soft(
        await failure({
          ...argsList(
            [
              [
                { m: { c: 1, d: 2 }, n: { e: 1, f: 2 } },
                { e: 1, f: 2 },
              ],
            ],
            "g"
          ),
          abi: nested,
        })
      )
      .toBe(
        'Argument Sets entry 1: x must be a whole number, got {"e":1,"f":2}. Only a tuple takes an object.'
      );
  });

  it("gives the count when values missing before a tuple may line it up", async () => {
    const abi = abiWith("f", [
      uint("w"),
      uint("x"),
      uint("y"),
      { name: "t", ...pair },
      uint("z"),
    ]);
    expect
      .soft(await failure({ ...argsList([[1, 2, { a: 1, b: 2 }]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1 has 3 values, but f takes 5 (w, x, y, t, z). Make each entry an array like [1, 1, 1, {"a": 1, "b": 1}, 1].'
      );
  });

  it("names the plain input after a tuple starting with a tuple", async () => {
    const abi = abiWith("f", [nestedO, uint("x"), uint("y")]);
    expect
      .soft(await failure({ ...argsList([[1, 2, { z: 1 }, 4]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1: y must be a whole number, got {"z":1}. Only a tuple takes an object.'
      );
  });

  it("leaves tuples after an object on a plain input out of the count", async () => {
    const abi = abiWith("h", [
      { name: "t", ...pair },
      uint("x"),
      { name: "u", ...pair },
    ]);
    expect
      .soft(
        await failure({ ...argsList([[1, 2, { z: 1 }, 4, 5, 6]], "h"), abi })
      )
      .toBe(
        'Argument Sets entry 1 has 6 values for h (t, x, u), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1, {"a": 1, "b": 1}].'
      );
  });

  it("names the plain input an object lands on before blaming a tuple slot", async () => {
    const abi = abiWith("f", [{ name: "t", ...pair }, uint("x")]);
    expect
      .soft(await failure({ ...argsList([[1, { z: 1 }]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1: x must be a whole number, got {"z":1}. Only a tuple takes an object.'
      );
  });

  it("keeps the count for a function with no tuple input", async () => {
    const abi = abiWith("f", [uint("x"), uint("y")]);
    expect
      .soft(await failure({ ...argsList([[0, { z: 1 }, 4]], "f"), abi }))
      .toBe(
        "Argument Sets entry 1 has 3 values, but f takes 2 (x, y). Make each entry an array like [1, 1]."
      );
  });

  it("keeps a later tuple out of the count after an object and a plain value", async () => {
    const abi = abiWith("f", [uint("x"), uint("y"), { name: "u", ...pair }]);
    expect
      .soft(await failure({ ...argsList([[{ z: 1 }, 1, 2, 3, 4]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1 has 5 values, but f takes 3 (x, y, u). Make each entry an array like [1, 1, {"a": 1, "b": 1}].'
      );
  });

  it("names a string input an object lands on", async () => {
    const abi = abiWith("f", [
      { name: "t", ...pair },
      { name: "s", type: "string" },
      uint("x"),
    ]);
    expect
      .soft(await failure({ ...argsList([[1, 2, { a: 1 }]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1: s must be a value of type string, got {"a":1}. Only a tuple takes an object.'
      );
  });

  it("names the plain input an object lands on when no tuple can take it", async () => {
    const abi = abiWith("mid", [
      { name: "who", type: "address" },
      { name: "p", ...pair },
      uint("k"),
    ]);
    expect(
      await failure({
        ...argsList([[addr(1), 1, { a: 1, b: 2 }]], "mid"),
        abi,
      })
    ).toBe(
      'Argument Sets entry 1: k must be a whole number, got {"a":1,"b":2}. Only a tuple takes an object.'
    );
  });

  it("does not blame a tuple given flat when a later value is missing", async () => {
    // t flat as (5, 2), x missing, u's object: the count, not a t blame.
    const later = abiWith("f", [
      { name: "t", ...pair },
      uint("x"),
      { name: "u", ...pair },
    ]);
    expect
      .soft(
        await failure({
          ...argsList([[5, 2, { a: 1, b: 2 }]], "f"),
          abi: later,
        })
      )
      .toBe(
        'Argument Sets entry 1 has 3 values for f (t, x, u), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1, {"a": 1, "b": 1}].'
      );
    // No tuple can take an object after t's span: the input is named.
    const plain = abiWith("g", [{ name: "t", ...pair }, uint("x"), uint("y")]);
    expect
      .soft(await failure({ ...argsList([[1, 2, { a: 1 }]], "g"), abi: plain }))
      .toBe(
        'Argument Sets entry 1: x must be a whole number, got {"a":1}. Only a tuple takes an object.'
      );
  });

  it("names the tuple when reading it flat puts an object on its member", async () => {
    // o's object would land on t.b if t were read flat.
    const before = abiWith("g", [{ name: "t", ...pair }, nestedO, uint("x")]);
    expect(
      await failure({
        ...argsList([[1, { inner: { a: 1, b: 2 }, id: 3 }, 5]], "g"),
        abi: before,
      })
    ).toBe(
      'Argument Sets entry 1: t must be an object with its member names, like {"a": 1, "b": 1}, got 1. Or give its 2 members flat in its place.'
    );
    // o holds 5, but with o fixed t still holds a plain value: the count.
    const first = abiWith("h", [nestedO, { name: "t", ...pair }]);
    expect(await failure({ ...argsList([[5, 1]], "h"), abi: first })).toBe(
      'Argument Sets entry 1 has 2 values for h (o, t), which takes 2 when t is an object, or 3 when t is given flat as its 2 members. Make each entry an array like [{"inner": {"a": 1, "b": 1}, "id": 1}, {"a": 1, "b": 1}].'
    );
  });

  it("counts a second tuple after the first one's members", async () => {
    const abi = abiWith("f", [
      { name: "t", ...pair },
      uint("x"),
      { name: "u", ...pair },
    ]);
    expect(await failure({ ...argsList([[1, 2, 3]], "f"), abi })).toBe(
      'Argument Sets entry 1 has 3 values for f (t, x, u), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, 1, {"a": 1, "b": 1}].'
    );
    // Reading u flat would put the object on a plain member, but t given flat
    // takes 4 values, so the count is not called wrong.
    const stop = abiWith("g", [
      { name: "t", ...pair },
      { name: "u", ...pair },
      uint("x"),
    ]);
    expect(
      await failure({
        ...argsList([[1, 2, 3, { a: 1, b: 2 }]], "g"),
        abi: stop,
      })
    ).toBe(
      'Argument Sets entry 1 has 4 values for g (t, u, x), a number it takes when tuples are given flat, but not in the right places. Make each entry an array like [{"a": 1, "b": 1}, {"a": 1, "b": 1}, 1].'
    );
  });

  it("offers no flat count in Function Arguments for a tuple starting with a tuple", async () => {
    const abi = abiWith("f", [nestedO, uint("x")]);
    expect(
      await failure(
        addressList([addr(1)], {
          abiFunction: "f",
          abi,
          functionArgs: JSON.stringify([1, 2, 3, 4]),
        })
      )
    ).toBe(
      "Function Arguments has 4 values, but f takes 2 (o, x). The same arguments go to every contract in the list."
    );
  });

  // Function Arguments pads missing values with blanks, so a tuple given flat
  // reads as a later argument left empty there.
  it("keeps Function Arguments padding and counts extra values", async () => {
    const abi = abiWith("f", [{ name: "t", ...pair }, uint("x"), uint("y")]);
    const shared = (values: unknown[]): Partial<BatchReadContractCoreInput> =>
      addressList([addr(1)], {
        abiFunction: "f",
        abi,
        functionArgs: JSON.stringify(values),
      });
    expect(await failure(shared([1, 2, 3]))).toBe(
      "Function Arguments: y: uint256 cannot be empty. Fill in every argument; only a string may be left blank."
    );
    expect(await failure(shared([1, 2, 3, 4, 5]))).toBe(
      "Function Arguments has 5 values for f (t, x, y), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. The same arguments go to every contract in the list."
    );
    // A blank left only for a string is sent as "".
    const str = abiWith("named", [
      { name: "p", ...pair },
      { name: "s", type: "string" },
    ]);
    const outcome = await run(
      addressList([addr(1)], {
        abiFunction: "named",
        abi: str,
        functionArgs: JSON.stringify([1, 2]),
      })
    );
    expect(outcome.success).toBe(true);
    const [call] = mockStaticCall.mock.calls[0][0] as Call[];
    expect(
      new ethers.Interface(str)
        .decodeFunctionData("named", call.callData)
        .toArray()
    ).toEqual([[BigInt(1), BigInt(2)], ""]);
  });

  // A flat reading that would put an object on a plain member isn't offered.
  it("counts no flat reading that puts an object on a plain member", async () => {
    const abi = abiWith("f", [
      { name: "t", ...pair },
      { name: "u", ...pair },
      uint("x"),
      uint("y"),
    ]);
    expect(
      await failure({ ...argsList([[1, { a: 1, b: 2 }, 2]], "f"), abi })
    ).toBe(
      'Argument Sets entry 1 has 3 values, but f takes 4 (t, u, x, y). Make each entry an array like [{"a": 1, "b": 1}, {"a": 1, "b": 1}, 1, 1].'
    );
  });

  // An object in a tuple's place is the whole tuple, so one whose first member
  // is a tuple can't be given flat, and no message offers that.
  it("does not offer flat members for a tuple that starts with a tuple", async () => {
    const nested = abiWith("f", [
      {
        name: "o",
        type: "tuple",
        components: [{ name: "inner", ...pair }, uint("id")],
      },
      uint("x"),
    ]);
    expect(await failure({ ...argsList([[1, 2]], "f"), abi: nested })).toBe(
      'Argument Sets entry 1: o must be an object with its member names, like {"inner": {"a": 1, "b": 1}, "id": 1}, got 1.'
    );
    expect(await failure({ ...argsList([[1, 2, 3]], "f"), abi: nested })).toBe(
      'Argument Sets entry 1 has 3 values, but f takes 2 (o, x). Make each entry an array like [{"inner": {"a": 1, "b": 1}, "id": 1}, 1].'
    );
    // Named before any count, whatever follows it.
    const before = abiWith("h", [
      {
        name: "o",
        type: "tuple",
        components: [{ name: "inner", ...pair }, uint("id")],
      },
      { name: "t", ...pair },
      uint("x"),
    ]);
    expect(
      await failure({ ...argsList([[1, 2, 3, 4]], "h"), abi: before })
    ).toBe(
      'Argument Sets entry 1: o must be an object with its member names, like {"inner": {"a": 1, "b": 1}, "id": 1}, got 1.'
    );
    expect(
      await failure({
        ...argsList([[[{ a: 1, b: 2 }, 3], 3, 4, 5]], "h"),
        abi: before,
      })
    ).toBe(
      'Argument Sets entry 1: give o as an object with its member names, like {"inner": {"a": 1, "b": 1}, "id": 1}, not as an array.'
    );
    const only = abiWith("g", [
      {
        name: "o",
        type: "tuple",
        components: [{ name: "inner", ...pair }, uint("id")],
      },
    ]);
    expect(await failure({ ...argsList([[1, 2, 3]], "g"), abi: only })).toBe(
      'Argument Sets entry 1 has 3 values, but g takes 1 (o). Make each entry an array like [{"inner": {"a": 1, "b": 1}, "id": 1}].'
    );
  });

  it("names a bad integer by its path before encoding", async () => {
    const abi = abiWith("tw", [
      { name: "who", type: "address" },
      { name: "n", type: "uint256" },
      {
        name: "t",
        type: "tuple",
        components: [
          { name: "a", type: "uint256" },
          { name: "s", type: "string" },
        ],
      },
      { name: "ids", type: "uint256[]" },
    ]);
    const call = (n: unknown, a: unknown, ids: unknown): unknown[][] => [
      [OWNER, n, { a, s: "y" }, ids],
    ];
    for (const text of ["x", "1.0", "1,000", "--1", "   ", "-", "0x"]) {
      expect(
        await failure({ ...argsList(call(text, "1", []), "tw"), abi })
      ).toBe(
        `Argument Sets entry 1: n must be a whole number in digits, got ${JSON.stringify(text)}.`
      );
    }
    expect(
      await failure({ ...argsList(call("1", "1.5", []), "tw"), abi })
    ).toBe(
      'Argument Sets entry 1: t.a must be a whole number in digits, got "1.5".'
    );
    expect(
      await failure({ ...argsList(call("1", "1", ["1", "x"]), "tw"), abi })
    ).toBe(
      'Argument Sets entry 1: ids[1] must be a whole number in digits, got "x".'
    );
    expect(await failure({ ...argsList(call(true, "1", []), "tw"), abi })).toBe(
      "Argument Sets entry 1: n must be a whole number, got true."
    );
    mockStaticCall.mockClear();
    const outcome = await run({
      ...argsList(call(" 5 ", "0x10", ["-0", "7"]), "tw"),
      abi,
    });
    expect(outcome.totalCalls).toBe(1);
  });

  it("calls a non-finite number out of range, and names NaN", async () => {
    // JSON cannot hold these; a list passed as a value can.
    expect(
      await failure({
        ...argsList([]),
        argsFromList: [Number.POSITIVE_INFINITY],
      })
    ).toBe(
      "Argument Sets entry 1: x is out of range for uint256, which cannot be negative and has a maximum."
    );
    expect(await failure({ ...argsList([]), argsFromList: [Number.NaN] })).toBe(
      "Argument Sets entry 1: x must be a whole number, got NaN."
    );
  });

  it("asks for all the digits for e-notation text", async () => {
    expect(await failure(argsList(["1e18"]))).toBe(
      'Argument Sets entry 1: x must be a whole number in digits, got "1e18". Write out all the digits.'
    );
    expect(await failure(argsList([".5e3"]))).toBe(
      'Argument Sets entry 1: x must be a whole number in digits, got ".5e3". Write out all the digits.'
    );
  });

  it("keeps the quotes advice for a type's maximum written as a number", async () => {
    // Each rounds to exactly 2^bits or 2^(bits-1), which is not past the limit.
    const two = BigInt(2);
    const cases: [string, string][] = [
      ["uint64", "18446744073709551615"],
      ["uint256", (two ** BigInt(256) - BigInt(1)).toString()],
      ["int256", (two ** BigInt(255) - BigInt(1)).toString()],
      ["int256", (-(two ** BigInt(255))).toString()],
    ];
    for (const [type, digits] of cases) {
      const abi = abiWith("edge", [{ name: "v", type }]);
      expect(
        await failure({ ...argsList(`[${digits}]`, "edge"), abi }),
        type
      ).toContain("v has too many digits to send as a number");
    }
    const abi = abiWith("edge", [{ name: "v", type: "uint256" }]);
    expect(await failure({ ...argsList("[1e80]", "edge"), abi })).toBe(
      "Argument Sets entry 1: v is out of range for uint256, which cannot be negative and has a maximum."
    );
    // The next double past 2^64: just over the limit.
    const wide = abiWith("edge", [{ name: "v", type: "uint64" }]);
    expect(
      await failure({
        ...argsList("[18446744073709556000]", "edge"),
        abi: wide,
      })
    ).toBe(
      "Argument Sets entry 1: v is out of range for uint64. Use a whole number from 0 to 18446744073709551615."
    );
    const narrow = abiWith("edge", [{ name: "v", type: "int64" }]);
    expect(
      await failure({
        ...argsList("[-9223372036854777856]", "edge"),
        abi: narrow,
      })
    ).toBe(
      "Argument Sets entry 1: v is out of range for int64. Use a whole number from -9223372036854775808 to 9223372036854775807."
    );
    const signed = abiWith("edge", [{ name: "v", type: "int256" }]);
    for (const list of ["[1e80]", "[-1e80]"]) {
      expect(
        await failure({ ...argsList(list, "edge"), abi: signed }),
        list
      ).toBe(
        "Argument Sets entry 1: v is out of range for int256, which has a minimum and a maximum."
      );
    }
  });

  it("calls a number past 2^53 out of range for a type of 53 bits or less", async () => {
    const abi = abiWith("small", [{ name: "v", type: "uint8" }]);
    for (const list of ["[1e20]", "[-1e20]", "[1e400]"]) {
      expect(await failure({ ...argsList(list, "small"), abi }), list).toBe(
        "Argument Sets entry 1: v is out of range for uint8. Use a whole number from 0 to 255."
      );
    }
    const wide = abiWith("small", [{ name: "v", type: "uint64" }]);
    expect(await failure({ ...argsList("[1e20]", "small"), abi: wide })).toBe(
      "Argument Sets entry 1: v is out of range for uint64. Use a whole number from 0 to 18446744073709551615."
    );
    const signed = abiWith("small", [{ name: "v", type: "int48" }]);
    expect(await failure({ ...argsList("[1e20]", "small"), abi: signed })).toBe(
      "Argument Sets entry 1: v is out of range for int48. Use a whole number from -140737488355328 to 140737488355327."
    );
  });

  it("calls a negative number past 2^53 out of range for a uint", async () => {
    expect(await failure(argsList("[-12345678901234567890]"))).toBe(
      "Argument Sets entry 1: x is out of range for uint256, which cannot be negative and has a maximum."
    );
  });

  it("takes a bigint, and names one where a number cannot go", async () => {
    mockStaticCall.mockClear();
    const outcome = await run({ ...argsList([]), argsFromList: [[BigInt(5)]] });
    expect(outcome.totalCalls).toBe(1);
    mockStaticCall.mockClear();
    expect(
      await failure({ ...argsList([]), argsFromList: [[[BigInt(5)]]] })
    ).toBe('Argument Sets entry 1: x must be a whole number, got ["5"].');
  });

  it("encodes the longest binary text a uint256 can take", async () => {
    mockStaticCall.mockClear();
    const outcome = await run(argsList([`0b${"1".repeat(256)}`]));
    expect(outcome.totalCalls).toBe(1);
  });
});

describe("batch-read-contract - fourth review", () => {
  const abiWith = (name: string, inputs: unknown[]): string =>
    JSON.stringify([
      {
        name,
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
  const uint = (name: string): { name: string; type: string } => ({
    name,
    type: "uint256",
  });
  const tupleOf = (
    name: string,
    components: unknown[]
  ): { name: string; type: string; components: unknown[] } => ({
    name,
    type: "tuple",
    components,
  });

  it("names a tuple given as text or an array before a tuple starting with a tuple", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [uint("a"), tupleOf("b", [uint("p")])]),
      tupleOf("s", [tupleOf("i", [uint("q")]), uint("c")]),
      uint("x"),
    ]);
    const s = { i: { q: 1 }, c: 1 };
    const asText =
      'Argument Sets entry 1: give t as an object with its member names, like {"a": 1, "b": {"p": 1}}, not as text.';
    expect
      .soft(
        await failure({
          ...argsList([['{"a":1,"b":{"p":1}}', s, 5]], "f"),
          abi,
        })
      )
      .toBe(asText);
    expect
      .soft(await failure({ ...argsList([[[1, { p: 1 }], s, 5]], "f"), abi }))
      .toBe(asText.replace("not as text", "not as an array"));
  });

  it("gives the count when a value before a tuple starting with a tuple is missing", async () => {
    const abi = abiWith("f", [
      uint("x"),
      tupleOf("t", [tupleOf("i", [uint("p")])]),
      tupleOf("s", [uint("a"), uint("b")]),
    ]);
    mockStaticCall.mockClear();
    const ok = await run({
      ...argsList([[1, { i: { p: 1 } }, 1, 2]], "f"),
      abi,
    });
    expect(ok.success).toBe(true);
    const [call] = mockStaticCall.mock.calls[0][0] as Call[];
    expect(
      new ethers.Interface(abi).decodeFunctionData("f", call.callData).toArray()
    ).toEqual([BigInt(1), [[BigInt(1)]], [BigInt(1), BigInt(2)]]);
    mockStaticCall.mockClear();
    expect
      .soft(await failure({ ...argsList([[{ i: { p: 1 } }, 1, 2]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1 has 3 values for f (x, t, s), which takes 3 when s is an object, or 4 when s is given flat as its 2 members. Make each entry an array like [1, {"i": {"p": 1}}, {"a": 1, "b": 1}].'
      );
  });

  it("names a plain input holding an object when the entry lines up without it", async () => {
    const abi = abiWith("f", [
      uint("x"),
      tupleOf("t", [tupleOf("i", [uint("p")])]),
    ]);
    expect
      .soft(
        await failure({
          ...argsList([[{ i: { p: 1 } }, { i: { p: 1 } }]], "f"),
          abi,
        })
      )
      .toBe(
        'Argument Sets entry 1: x must be a whole number, got {"i":{"p":1}}. Only a tuple takes an object.'
      );
    // Nothing lines up with one value fixed, and no tuple can change the count.
    const two = abiWith("g", [
      uint("x"),
      uint("y"),
      tupleOf("t", [tupleOf("i", [uint("p")])]),
    ]);
    expect
      .soft(
        await failure({
          ...argsList([[{ i: { p: 1 } }, { i: { p: 1 } }, 1]], "g"),
          abi: two,
        })
      )
      .toBe(
        'Argument Sets entry 1 has 3 values for g (x, y, t), the right number, but not in the right places. Make each entry an array like [1, 1, {"i": {"p": 1}}].'
      );
  });

  it("names a tuple starting with a tuple when each value has one place", async () => {
    const nested = (name: string): ReturnType<typeof tupleOf> =>
      tupleOf(name, [tupleOf("inner", [uint("a"), uint("b")]), uint("id")]);
    const abi = abiWith("f", [nested("o"), nested("p")]);
    const object = { inner: { a: 1, b: 2 }, id: 3 };
    expect(await failure({ ...argsList([[5, object]], "f"), abi })).toBe(
      'Argument Sets entry 1: o must be an object with its member names, like {"inner": {"a": 1, "b": 1}, "id": 1}, got 5.'
    );
  });

  it("does not call a tuple text or an array when a value before it is missing", async () => {
    const ids = { name: "ids", type: "uint256[]" };
    const nested = abiWith("f", [
      uint("x"),
      tupleOf("t", [tupleOf("i", [uint("p")])]),
      ids,
    ]);
    expect
      .soft(
        await failure({
          ...argsList([[{ i: { p: 1 } }, [1]]], "f"),
          abi: nested,
        })
      )
      .toBe(
        'Argument Sets entry 1 has 2 values, but f takes 3 (x, t, ids). Make each entry an array like [1, {"i": {"p": 1}}, [1, 1]].'
      );
    const pair = abiWith("g", [
      uint("x"),
      tupleOf("t", [uint("a"), uint("b")]),
      ids,
    ]);
    expect
      .soft(
        await failure({
          ...argsList([[{ a: 1, b: 2 }, [1, 2]]], "g"),
          abi: pair,
        })
      )
      .toBe(
        'Argument Sets entry 1 has 2 values, but g takes 3 (x, t, ids). Make each entry an array like [1, {"a": 1, "b": 1}, [1, 1]].'
      );
    const memo = abiWith("h", [
      uint("x"),
      tupleOf("t", [uint("a"), uint("b")]),
      { name: "memo", type: "string" },
    ]);
    expect
      .soft(
        await failure({
          ...argsList([[{ a: 1, b: 2 }, "[1]"]], "h"),
          abi: memo,
        })
      )
      .toBe(
        'Argument Sets entry 1 has 2 values, but h takes 3 (x, t, memo). Make each entry an array like [1, {"a": 1, "b": 1}, "..."].'
      );
    expect
      .soft(
        await failure(
          addressList([addr(1)], {
            abi: pair,
            abiFunction: "g",
            functionArgs: JSON.stringify([{ a: 1, b: 2 }, [1, 2]]),
          })
        )
      )
      // ids is not a string, so it is not read as left blank.
      .toBe(
        "Function Arguments has 2 values, but g takes 3 (x, t, ids). The same arguments go to every contract in the list."
      );
  });

  it("does not name a tuple that can go flat when fixing it leaves an object on a plain input", async () => {
    const abi = abiWith("f", [
      uint("x"),
      tupleOf("t", [uint("a"), uint("b")]),
      tupleOf("s", [uint("c"), uint("d")]),
    ]);
    expect(
      await failure({
        ...argsList([[{ a: 1, b: 2 }, 5, { c: 1, d: 2 }]], "f"),
        abi,
      })
    ).toBe(
      'Argument Sets entry 1 has 3 values for f (x, t, s), which takes 3 when t is an object, or 4 when t is given flat as its 2 members. Make each entry an array like [1, {"a": 1, "b": 1}, {"c": 1, "d": 1}].'
    );
    const two = abiWith("g", [uint("x"), tupleOf("s", [uint("a"), uint("b")])]);
    expect(
      await failure({ ...argsList([[{ a: 1, b: 2 }, 5]], "g"), abi: two })
    ).toBe(
      'Argument Sets entry 1 has 2 values for g (x, s), which takes 2 when s is an object, or 3 when s is given flat as its 2 members. Make each entry an array like [1, {"a": 1, "b": 1}].'
    );
  });

  it("does not name a tuple when an object before it belongs to no tuple there", async () => {
    const abi = abiWith("f", [
      tupleOf("pa", [uint("a"), uint("b")]),
      tupleOf("nb", [tupleOf("i", [uint("p")]), uint("c")]),
      tupleOf("lc", [uint("a"), tupleOf("b", [uint("p")])]),
    ]);
    expect(
      await failure({
        ...argsList([[{ i: { p: 1 }, c: 1 }, 1, { p: 1 }]], "f"),
        abi,
      })
    ).toBe(
      'Argument Sets entry 1 has 3 values for f (pa, nb, lc), which takes 3 when pa is an object, or 4 when pa is given flat as its 2 members. Make each entry an array like [{"a": 1, "b": 1}, {"i": {"p": 1}, "c": 1}, {"a": 1, "b": {"p": 1}}].'
    );
    // An object missing a member still lines up, so the later tuple is named.
    const partial = abiWith("g", [
      tupleOf("t", [uint("a"), uint("b")]),
      tupleOf("s", [tupleOf("i", [uint("p")]), uint("c")]),
    ]);
    expect(
      await failure({ ...argsList([[{ a: 1 }, 5]], "g"), abi: partial })
    ).toBe(
      'Argument Sets entry 1: s must be an object with its member names, like {"i": {"p": 1}, "c": 1}, got 5.'
    );
  });

  it("does not offer flat a tuple that holds its own object", async () => {
    const abi = abiWith("f", [
      uint("x"),
      tupleOf("t", [uint("a"), uint("b")]),
      tupleOf("n", [tupleOf("i", [uint("p")])]),
    ]);
    expect(
      await failure({
        ...argsList([[{ i: { p: 1 } }, { a: 1, b: 2 }, { i: { p: 1 } }]], "f"),
        abi,
      })
    ).toBe(
      'Argument Sets entry 1: x must be a whole number, got {"i":{"p":1}}. Only a tuple takes an object.'
    );
  });

  it("keeps blanks at the end of Function Arguments out of the line-up", async () => {
    const abi = abiWith("g", [tupleOf("t", [uint("a"), uint("b")]), uint("y")]);
    expect
      .soft(
        await failure(
          addressList([addr(1)], {
            abi,
            abiFunction: "g",
            functionArgs: JSON.stringify([[1, 2], ""]),
          })
        )
      )
      // y is stored blank, so t given as an array is named, as in Argument Sets.
      .toBe(
        'Function Arguments: give t as an object with its member names, like {"a": 1, "b": 1}, not as an array.'
      );
    // In Argument Sets a missing value is not a blank, so the count is given.
    expect
      .soft(await failure({ ...argsList([[[1, 2]]], "g"), abi }))
      .toBe(
        'Argument Sets entry 1 has 1 value, but g takes 2 (t, y). Make each entry an array like [{"a": 1, "b": 1}, 1].'
      );
  });

  it("offers flat the first tuple holding a plain value, not one holding its object", async () => {
    const abi = abiWith("f", [
      uint("x"),
      tupleOf("t", [uint("a"), uint("b")]),
      tupleOf("s", [uint("c"), uint("d")]),
    ]);
    expect(
      await failure({
        ...argsList([[{ a: 1, b: 2 }, { a: 1, b: 2 }, 5]], "f"),
        abi,
      })
    ).toBe(
      'Argument Sets entry 1 has 3 values for f (x, t, s), which takes 3 when s is an object, or 4 when s is given flat as its 2 members. Make each entry an array like [1, {"a": 1, "b": 1}, {"c": 1, "d": 1}].'
    );
  });

  it("names the plain input an object sits on when the entry lines up without it", async () => {
    const abi = abiWith("h", [
      uint("x"),
      tupleOf("t", [tupleOf("i", [uint("p")])]),
      tupleOf("s", [uint("a"), uint("b")]),
    ]);
    const named =
      'Argument Sets entry 1: x must be a whole number, got {"i":{"p":1}}. Only a tuple takes an object.';
    // Both s as an object and s flat name x, so the user is not sent back and forth.
    expect
      .soft(
        await failure({
          ...argsList(
            [[{ i: { p: 1 } }, { i: { p: 1 } }, { a: 1, b: 1 }]],
            "h"
          ),
          abi,
        })
      )
      .toBe(named);
    expect
      .soft(
        await failure({
          ...argsList([[{ i: { p: 1 } }, { i: { p: 1 } }, 1, 2]], "h"),
          abi,
        })
      )
      .toBe(named);
  });

  it("names the first of two tuples given as text or arrays", async () => {
    const abi = abiWith("two", [
      tupleOf("a", [uint("x"), uint("y")]),
      tupleOf("b", [
        { name: "who", type: "address" },
        { name: "on", type: "bool" },
      ]),
    ]);
    expect
      .soft(
        await failure({
          ...argsList(
            [
              [
                ["1", "2"],
                [addr(1), true],
              ],
            ],
            "two"
          ),
          abi,
        })
      )
      .toBe(
        'Argument Sets entry 1: give a as an object with its member names, like {"x": 1, "y": 1}, not as an array.'
      );
    expect
      .soft(
        await failure({
          ...argsList(
            [['{"x":"1","y":"2"}', `{"who":"${addr(1)}","on":true}`]],
            "two"
          ),
          abi,
        })
      )
      .toBe(
        'Argument Sets entry 1: give a as an object with its member names, like {"x": 1, "y": 1}, not as text.'
      );
  });

  it("walks past an earlier tuple to the plain input holding an object", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [uint("a"), uint("b")]),
      uint("x"),
      tupleOf("n", [tupleOf("i", [uint("p")])]),
    ]);
    const named =
      'Argument Sets entry 1: x must be a whole number, got {"i":{"p":1}}. Only a tuple takes an object.';
    // t given flat, as an object, and as an array.
    for (const entry of [
      [1, 2, { i: { p: 1 } }, { i: { p: 1 } }],
      [{ a: 1, b: 2 }, { i: { p: 1 } }, { i: { p: 1 } }],
      [[1, 2], { i: { p: 1 } }, { i: { p: 1 } }],
    ]) {
      expect
        .soft(await failure({ ...argsList([entry], "f"), abi }))
        .toBe(named);
    }
  });

  it("does not name a plain input when an extra value may have shifted a tuple's object onto it", async () => {
    const abi = abiWith("f", [
      tupleOf("na", [tupleOf("i", [uint("p")]), uint("c")]),
      uint("ub"),
      tupleOf("lc", [uint("a"), tupleOf("b", [uint("p")])]),
    ]);
    expect(
      await failure({
        ...argsList(
          [[9, { i: { p: 1 }, c: 1 }, 1, { a: 1, b: { p: 1 } }]],
          "f"
        ),
        abi,
      })
    ).toBe(
      'Argument Sets entry 1 has 4 values for f (na, ub, lc), the number it takes when lc is given flat as its 2 members, but not in the right places. Make each entry an array like [{"i": {"p": 1}, "c": 1}, 1, {"a": 1, "b": {"p": 1}}].'
    );
  });

  it("names a plain input when the earlier tuple holding a fitting object holds its own", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [uint("a"), uint("b")]),
      uint("x"),
      tupleOf("n", [tupleOf("i", [uint("p")])]),
    ]);
    expect(
      await failure({
        ...argsList([[{ a: 1, b: 2 }, { a: 1, b: 2 }, { i: { p: 1 } }]], "f"),
        abi,
      })
    ).toBe(
      'Argument Sets entry 1: x must be a whole number, got {"a":1,"b":2}. Only a tuple takes an object.'
    );
  });
});

describe("batch-read-contract - fifth review", () => {
  const abiWith = (name: string, inputs: unknown[]): string =>
    JSON.stringify([
      {
        name,
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
  const uint = (name: string): { name: string; type: string } => ({
    name,
    type: "uint256",
  });
  const tupleOf = (
    name: string,
    components: unknown[]
  ): { name: string; type: string; components: unknown[] } => ({
    name,
    type: "tuple",
    components,
  });
  const nestedT = tupleOf("t", [tupleOf("i", [uint("p")])]);

  it("names a tuple starting with a tuple that holds a plain value, not the tuple after it", async () => {
    const abi = abiWith("f", [
      nestedT,
      tupleOf("s", [uint("a"), { name: "b", type: "uint256[]" }]),
    ]);
    // s is given flat and is fine; t holds 1.
    expect(await failure({ ...argsList([[1, [1, 2]]], "f"), abi })).toBe(
      'Argument Sets entry 1: t must be an object with its member names, like {"i": {"p": 1}}, got 1.'
    );
  });

  it("lines up a tuple starting with a tuple on the whole tuple as text or an array", async () => {
    const abi = abiWith("f", [nestedT, tupleOf("s", [uint("a"), uint("b")])]);
    expect
      .soft(
        await failure({ ...argsList([['{"i": {"p": 1}}', 1, 2]], "f"), abi })
      )
      .toBe(
        'Argument Sets entry 1: give t as an object with its member names, like {"i": {"p": 1}}, not as text.'
      );
    expect
      .soft(await failure({ ...argsList([[[[1]], 1, 2]], "f"), abi }))
      .toBe(
        'Argument Sets entry 1: give t as an object with its member names, like {"i": {"p": 1}}, not as an array.'
      );
  });

  it("does not send a swapped entry back and forth between messages", async () => {
    const abi = abiWith("h", [
      uint("x"),
      nestedT,
      tupleOf("s", [uint("a"), uint("b")]),
    ]);
    // t's object on x and a plain value on t: fixing x alone does not line up.
    expect
      .soft(
        await failure({
          ...argsList([[{ i: { p: 1 } }, 1, { a: 1, b: 1 }]], "h"),
          abi,
        })
      )
      .toBe(
        'Argument Sets entry 1 has 3 values for h (x, t, s), the right number, but not in the right places. Make each entry an array like [1, {"i": {"p": 1}}, {"a": 1, "b": 1}].'
      );
    // With s given flat the count is not called wrong either.
    expect
      .soft(
        await failure({ ...argsList([[{ i: { p: 1 } }, 1, 1, 2]], "h"), abi })
      )
      .toBe(
        'Argument Sets entry 1 has 4 values for h (x, t, s), the number it takes when s is given flat as its 2 members, but not in the right places. Make each entry an array like [1, {"i": {"p": 1}}, {"a": 1, "b": 1}].'
      );
  });

  it("keeps the plain count when no flat reading takes that many values", async () => {
    const abi = abiWith("f", [uint("x"), nestedT]);
    expect(
      await failure({ ...argsList([[1, { i: { p: 1 } }, 3]], "f"), abi })
    ).toBe(
      'Argument Sets entry 1 has 3 values, but f takes 2 (x, t). Make each entry an array like [1, {"i": {"p": 1}}].'
    );
  });

  it("lines up a tuple member that is a tuple only on its object, text or an array", async () => {
    const abi = abiWith("f", [
      tupleOf("s", [uint("a"), nestedT]),
      tupleOf("u", [uint("c"), { name: "d", type: "uint256[]" }]),
    ]);
    // u is given flat and is fine; s.t holds 1, so u is not named.
    const entry = [1, 1, [1, 2]];
    expect
      .soft(await failure({ ...argsList([entry], "f"), abi }))
      .toBe(
        'Argument Sets entry 1 has 3 values for f (s, u), a number it takes when tuples are given flat, but not in the right places. Make each entry an array like [{"a": 1, "t": {"i": {...}}}, {"c": 1, "d": [1, 1]}].'
      );
    expect
      .soft(
        await failure({
          ...addressList([CONTRACT], { functionArgs: JSON.stringify(entry) }),
          abiFunction: "f",
          abi,
        })
      )
      .toBe(
        "Function Arguments has 3 values for f (s, u), a number it takes when tuples are given flat, but not in the right places. The same arguments go to every contract in the list."
      );
    // With s.t given its object, u given as an array is named.
    expect
      .soft(
        await failure({
          ...argsList([[1, { i: { p: 1 } }, [1, 2]]], "f"),
          abi,
        })
      )
      .toBe(
        // [1,2] has no array for d, so it is not read as the whole of u.
        'Argument Sets entry 1: u must be an object with its member names, like {"c": 1, "d": [1, 1]}, got [1,2]. Or give its 2 members flat in its place.'
      );
  });

  it("lines up an array member only on an array", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [
        { name: "i", type: "tuple[]", components: [uint("p")] },
        uint("q"),
      ]),
      tupleOf("s", [uint("a"), { name: "b", type: "uint256[]" }]),
    ]);
    // t.i holds 1, so s, given flat, is not named; t's place holds the 1.
    expect(await failure({ ...argsList([[1, 2, [1, 2]]], "f"), abi })).toBe(
      'Argument Sets entry 1: t must be an object with its member names, like {"i": [{...}, {...}], "q": 1}, got 1. Or give its 2 members flat in its place.'
    );
  });

  it("names a tuple starting with a tuple in Function Arguments as in Argument Sets", async () => {
    const abi = abiWith("f", [
      nestedT,
      tupleOf("s", [uint("a"), { name: "b", type: "uint256[]" }]),
    ]);
    expect(
      await failure({
        ...addressList([CONTRACT], {
          functionArgs: JSON.stringify([1, [1, 2]]),
        }),
        abiFunction: "f",
        abi,
      })
    ).toBe(
      'Function Arguments: t must be an object with its member names, like {"i": {"p": 1}}, got 1.'
    );
  });

  const both = async (
    abi: string,
    entry: unknown[]
  ): Promise<[string, string]> => [
    await failure({ ...argsList([entry], "f"), abi }),
    await failure({
      ...addressList([CONTRACT], { functionArgs: JSON.stringify(entry) }),
      abiFunction: "f",
      abi,
    }),
  ];

  it("names a tuple holding a plain value before a correct array, in both fields", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [uint("a"), uint("b")]),
      { name: "xs", type: "uint256[]" },
    ]);
    // xs is given correctly; a plain member takes no array.
    const [args, shared] = await both(abi, [1, [1, 2]]);
    const named =
      't must be an object with its member names, like {"a": 1, "b": 1}, got 1. Or give its 2 members flat in its place.';
    expect.soft(args).toBe(`Argument Sets entry 1: ${named}`);
    expect.soft(shared).toBe(`Function Arguments: ${named}`);
  });

  it("gives a swapped entry the same message in both fields", async () => {
    const abi = abiWith("f", [
      uint("x"),
      nestedT,
      tupleOf("s", [uint("a"), uint("b")]),
    ]);
    const [args, shared] = await both(abi, [{ i: { p: 1 } }, 1, 1, 2]);
    const counted =
      "has 4 values for f (x, t, s), the number it takes when s is given flat as its 2 members, but not in the right places.";
    expect
      .soft(args)
      .toBe(
        `Argument Sets entry 1 ${counted} Make each entry an array like [1, {"i": {"p": 1}}, {"a": 1, "b": 1}].`
      );
    expect
      .soft(shared)
      .toBe(
        `Function Arguments ${counted} The same arguments go to every contract in the list.`
      );
  });

  it("asks to fill in a tuple the editor left blank", async () => {
    const abi = abiWith("f", [nestedT, uint("x")]);
    const [, shared] = await both(abi, ["", "5"]);
    expect(shared).toBe(
      "Function Arguments: t.i.p: uint256 cannot be empty. Fill in every argument; only a string may be left blank."
    );
  });

  it("names a tuple starting with a tuple with the count right, not with a number missing at the end", async () => {
    const [, equal] = await both(abiWith("f", [nestedT, uint("x")]), [1, 2]);
    expect
      .soft(equal)
      .toBe(
        'Function Arguments: t must be an object with its member names, like {"i": {"p": 1}}, got 1.'
      );
    // y is a number, so a missing y is not a blank: the count is given.
    const [, short] = await both(
      abiWith("f", [nestedT, uint("x"), uint("y")]),
      [1, 2]
    );
    expect
      .soft(short)
      .toBe(
        "Function Arguments has 2 values, but f takes 3 (t, x, y). The same arguments go to every contract in the list."
      );
  });

  it("does not take an object that fits no member as a tuple member", async () => {
    const abi = abiWith("f", [
      tupleOf("s", [uint("a"), nestedT]),
      tupleOf("u", [uint("c"), { name: "d", type: "uint256[]" }]),
    ]);
    const [args] = await both(abi, [1, { zz: 1 }, [1, 2]]);
    // {zz} fits no member of t, so u is not named.
    expect(args).toBe(
      'Argument Sets entry 1 has 3 values for f (s, u), a number it takes when tuples are given flat, but not in the right places. Make each entry an array like [{"a": 1, "t": {"i": {...}}}, {"c": 1, "d": [1, 1]}].'
    );
  });

  it("lines up an array member on JSON array text", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [{ name: "b", type: "uint256[]" }, uint("q")]),
      tupleOf("s", [uint("a"), { name: "c", type: "uint256[]" }]),
    ]);
    const [args, shared] = await both(abi, ["[1,2]", 2, [1, [1, 2]]]);
    const named =
      'give s as an object with its member names, like {"a": 1, "c": [1, 1]}, not as an array.';
    expect.soft(args).toBe(`Argument Sets entry 1: ${named}`);
    expect.soft(shared).toBe(`Function Arguments: ${named}`);
  });

  it("names a tuple whose flat reading would put a plain value on an array member", async () => {
    const abi = abiWith("f", [
      uint("x"),
      tupleOf("t", [uint("a"), { name: "b", type: "uint256[]" }]),
      uint("y"),
    ]);
    expect(await failure({ ...argsList([[1, 2, 3]], "f"), abi })).toBe(
      'Argument Sets entry 1: t must be an object with its member names, like {"a": 1, "b": [1, 1]}, got 2. Or give its 2 members flat in its place.'
    );
  });

  it("names the one flat tuple next to a one-member tuple", async () => {
    const abi = abiWith("f", [
      tupleOf("w", [uint("p")]),
      tupleOf("s", [uint("a"), uint("b")]),
      uint("x"),
    ]);
    expect(
      await failure({
        ...argsList([[{ a: 1, b: 2 }, { p: 1 }, 1, 2]], "f"),
        abi,
      })
    ).toContain("the number it takes when s is given flat as its 2 members");
  });

  it("names a value nested too deeply to show by its kind", async () => {
    const deep = `${"[".repeat(4000)}1${"]".repeat(4000)}`;
    const message = await failure({
      ...argsList(`[[${deep}]]`),
    });
    expect(message).not.toContain("Maximum call stack");
  });

  it("names a tuple holding a plain value before a tuple given flat, in both fields", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [uint("a"), uint("b")]),
      tupleOf("s", [{ name: "c", type: "uint256[]" }, uint("d")]),
    ]);
    const named =
      't must be an object with its member names, like {"a": 1, "b": 1}, got 1. Or give its 2 members flat in its place.';
    for (const entry of [
      [1, [1], 2],
      [1, "[1]", 2],
    ]) {
      const [args, shared] = await both(abi, entry);
      expect
        .soft(args, JSON.stringify(entry))
        .toBe(`Argument Sets entry 1: ${named}`);
      expect
        .soft(shared, JSON.stringify(entry))
        .toBe(`Function Arguments: ${named}`);
    }
  });

  it("does not take array text as a plain value", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [uint("a"), uint("b")]),
      { name: "xs", type: "uint256[]" },
    ]);
    const named =
      't must be an object with its member names, like {"a": 1, "b": 1}, got 1. Or give its 2 members flat in its place.';
    const [args, shared] = await both(abi, [1, "[1,2]"]);
    expect.soft(args).toBe(`Argument Sets entry 1: ${named}`);
    expect.soft(shared).toBe(`Function Arguments: ${named}`);
  });

  it("leaves text that is not JSON to the member it sits on", async () => {
    const abi = abiWith("f", [tupleOf("t", [uint("a"), uint("b")]), uint("x")]);
    const [, shared] = await both(abi, ["[1", "3", ""]);
    expect(shared).not.toContain("not as text");
  });

  it("gives the count, not a padded member message, when a short entry does not line up", async () => {
    const abi = abiWith("f", [
      tupleOf("t", [tupleOf("i", [uint("p")]), uint("q")]),
      uint("x"),
      uint("y"),
    ]);
    const [, shared] = await both(abi, ["5", [1], ""]);
    expect(shared).not.toContain("expected object for tuple");
  });

  it("ends a blank tuple's message with its own field's next step", async () => {
    const abi = abiWith("f", [nestedT, uint("x")]);
    const [args] = await both(abi, ["", 5]);
    expect(args).toBe(
      'Argument Sets entry 1: t cannot be empty. Give it as an object with its member names, like {"i": {"p": 1}}.'
    );
  });

  // Function Arguments reads values missing at the end as inputs left blank;
  // Argument Sets does not. Each pair pins both fields on one entry.
  it("pins both fields on line-up edge cases", async () => {
    const arr = (name: string): { name: string; type: string } => ({
      name,
      type: "uint256[]",
    });
    const cases: [string, unknown[], string, string][] = [
      // An array on plain x does not line up, so t is not named.
      [
        abiWith("f", [nestedT, uint("x")]),
        [5, [1, 2]],
        'Argument Sets entry 1 has 2 values for f (t, x), the right number, but not in the right places. Make each entry an array like [{"i": {"p": 1}}, 1].',
        "Function Arguments has 2 values for f (t, x), the right number, but not in the right places. The same arguments go to every contract in the list.",
      ],
      [
        abiWith("f", [
          { name: "o", type: "string" },
          tupleOf("s", [uint("a"), arr("b")]),
        ]),
        [{ a: 1 }, 2],
        'Argument Sets entry 1 has 2 values for f (o, s), which takes 2 when s is an object, or 3 when s is given flat as its 2 members. Make each entry an array like ["...", {"a": 1, "b": [1, 1]}].',
        // {"a":1} may be s's object with o missing: not tied to o.
        "Function Arguments has 2 values for f (o, s), which takes 2 when s is an object, or 3 when s is given flat as its 2 members. The same arguments go to every contract in the list.",
      ],
      [
        abiWith("f", [
          uint("x"),
          tupleOf("t", [arr("a"), uint("b")]),
          uint("y"),
        ]),
        [1, 2],
        'Argument Sets entry 1 has 2 values, but f takes 3 (x, t, y). Make each entry an array like [1, {"a": [1, 1], "b": 1}, 1].',
        // y is a number, so it is not read as left blank.
        "Function Arguments has 2 values, but f takes 3 (x, t, y). The same arguments go to every contract in the list.",
      ],
      [
        abiWith("f", [
          uint("x"),
          tupleOf("t", [arr("a"), uint("b")]),
          tupleOf("u", [arr("a"), uint("b")]),
        ]),
        [1, 2],
        'Argument Sets entry 1 has 2 values, but f takes 3 (x, t, u). Make each entry an array like [1, {"a": [1, 1], "b": 1}, {"a": [1, 1], "b": 1}].',
        "Function Arguments has 2 values, but f takes 3 (x, t, u). The same arguments go to every contract in the list.",
      ],
      [
        abiWith("f", [nestedT]),
        [' {"i": {"p": 1}}'],
        'Argument Sets entry 1: give t as an object with its member names, like {"i": {"p": 1}}, not as text.',
        'Function Arguments: give t as an object with its member names, like {"i": {"p": 1}}, not as text.',
      ],
      [
        abiWith("f", [tupleOf("t", [uint("a"), uint("q")]), uint("x")]),
        ['\n{"a":1,"q":2}', 3],
        'Argument Sets entry 1: give t as an object with its member names, like {"a": 1, "q": 1}, not as text.',
        'Function Arguments: give t as an object with its member names, like {"a": 1, "q": 1}, not as text.',
      ],
      [
        abiWith("f", [
          nestedT,
          tupleOf("s", [uint("a"), uint("b"), uint("c")]),
          uint("y"),
        ]),
        [5, 1, 2, 3],
        'Argument Sets entry 1 has 4 values for f (t, s, y), which takes 3 when s is an object, or 5 when s is given flat as its 3 members. Make each entry an array like [{"i": {"p": 1}}, {"a": 1, "b": 1, "c": 1}, 1].',
        "Function Arguments has 4 values for f (t, s, y), which takes 3 when s is an object, or 5 when s is given flat as its 3 members. The same arguments go to every contract in the list.",
      ],
      [
        abiWith("f", [
          nestedT,
          tupleOf("s", [uint("a"), uint("b")]),
          uint("y"),
        ]),
        [5, 1, 2],
        'Argument Sets entry 1 has 3 values for f (t, s, y), which takes 3 when s is an object, or 4 when s is given flat as its 2 members. Make each entry an array like [{"i": {"p": 1}}, {"a": 1, "b": 1}, 1].',
        "Function Arguments has 3 values for f (t, s, y), which takes 3 when s is an object, or 4 when s is given flat as its 2 members. The same arguments go to every contract in the list.",
      ],
    ];
    for (const [abi, entry, args, shared] of cases) {
      const [gotArgs, gotShared] = await both(abi, entry);
      expect.soft(gotArgs, JSON.stringify(entry)).toBe(args);
      expect.soft(gotShared, JSON.stringify(entry)).toBe(shared);
    }
  });

  it("reads broken JSON text as a member's bad value, not a whole tuple", async () => {
    const abi = abiWith("f", [tupleOf("t", [uint("a"), uint("b")]), uint("x")]);
    const [, shared] = await both(abi, ["[1", "3", ""]);
    // x is stored blank, so nothing is missing and t.a is named, in both fields.
    expect(shared).toBe(
      'Function Arguments: t.a must be a whole number in digits, got "[1".'
    );
    const [args] = await both(abi, ["[1", "3", "4"]);
    expect(args).toBe(
      'Argument Sets entry 1: t.a must be a whole number in digits, got "[1".'
    );
  });

  it("gives the count when a value given fails and another is missing", async () => {
    const abi = abiWith("f", [uint("x"), { name: "s", type: "string" }]);
    const [, shared] = await both(abi, [[1], ""]);
    // s is stored blank: nothing is missing, so x is named.
    expect(shared).toBe(
      "Function Arguments: x must be a whole number, got [1]."
    );
    // s is left out and x fails, so it may have moved: the count.
    const [, missing] = await both(abi, [[1]]);
    expect(missing).toBe(
      "Function Arguments has 1 value, but f takes 2 (x, s). The same arguments go to every contract in the list."
    );
  });

  it("reads a member missing at the end of Function Arguments as left blank", async () => {
    const abi = abiWith("f", [
      uint("x"),
      tupleOf("t", [uint("a"), { name: "b", type: "uint256[]" }]),
    ]);
    const [, shared] = await both(abi, [1, 2]);
    // t is read flat with b left blank; the wording is lib/abi's.
    expect(shared).toBe(
      "Function Arguments: t.b: expected array for uint256[]. Check the arguments for f (x, t)."
    );
  });

  it("reads broken object text in a tuple's place as a try at the tuple", async () => {
    const abi = abiWith("f", [tupleOf("t", [uint("a"), uint("b")]), uint("x")]);
    const [, shared] = await both(abi, ['{"a":1,', "5"]);
    expect(shared).toBe(
      'Function Arguments: t must be an object with its member names, like {"a": 1, "b": 1}, got "{\\"a\\":1,". Or give its 2 members flat in its place.'
    );
  });

  it("does not pad a short entry whose tuple starting with a tuple holds a plain value", async () => {
    const abi = abiWith("f", [
      tupleOf("s", [tupleOf("i", [uint("p")]), uint("q")]),
      uint("x"),
      uint("y"),
    ]);
    const [, shared] = await both(abi, ["5", [1]]);
    expect(shared).toBe(
      "Function Arguments has 2 values, but f takes 3 (s, x, y). The same arguments go to every contract in the list."
    );
  });
});

describe("batch-read-contract - sixth review", () => {
  const abiWith = (inputs: unknown[]): string =>
    JSON.stringify([
      {
        name: "f",
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
  const uint = (name: string): { name: string; type: string } => ({
    name,
    type: "uint256",
  });
  const str = (name: string): { name: string; type: string } => ({
    name,
    type: "string",
  });
  const tupleOf = (
    name: string,
    components: unknown[]
  ): { name: string; type: string; components: unknown[] } => ({
    name,
    type: "tuple",
    components,
  });
  const both = async (
    abi: string,
    entry: unknown[]
  ): Promise<[string, string]> => [
    await failure({ ...argsList([entry], "f"), abi }),
    await failure({
      ...addressList([CONTRACT], { functionArgs: JSON.stringify(entry) }),
      abiFunction: "f",
      abi,
    }),
  ];

  it("does not blame a string whose value moved left when a value before it is missing", async () => {
    const abi = abiWith([
      uint("a"),
      str("s"),
      tupleOf("t", [uint("x"), uint("y")]),
    ]);
    const [args, shared] = await both(abi, ["hi", { x: 1, y: 2 }]);
    expect
      .soft(args)
      .toBe(
        'Argument Sets entry 1 has 2 values, but f takes 3 (a, s, t). Make each entry an array like [1, "...", {"x": 1, "y": 1}].'
      );
    expect
      .soft(shared)
      .toBe(
        "Function Arguments has 2 values, but f takes 3 (a, s, t). The same arguments go to every contract in the list."
      );
  });

  it("does not read a missing number or tuple at the end as left blank", async () => {
    const abi = abiWith([str("s"), uint("n"), tupleOf("t", [uint("x")])]);
    const [args, shared] = await both(abi, [{ x: 1 }]);
    expect
      .soft(args)
      .toBe(
        'Argument Sets entry 1 has 1 value, but f takes 3 (s, n, t). Make each entry an array like ["...", 1, {"x": 1}].'
      );
    expect
      .soft(shared)
      .toBe(
        "Function Arguments has 1 value, but f takes 3 (s, n, t). The same arguments go to every contract in the list."
      );
  });

  it("reads a flat tuple of strings missing at the end as left blank", async () => {
    const abi = abiWith([uint("n"), tupleOf("t", [str("a"), str("b")])]);
    const shared = (entry: unknown[]): Promise<Outcome> =>
      run({
        ...addressList([CONTRACT], { functionArgs: JSON.stringify(entry) }),
        abiFunction: "f",
        abi,
      });
    expect((await shared(["7"])).success).toBe(true);
    // A value given fails while blanks are padded: the count, not n.
    expect((await shared(["x1"])).error).toBe(
      "Function Arguments has 1 value, but f takes 2 (n, t). The same arguments go to every contract in the list."
    );
  });

  it("still reads a missing string at the end as left blank", async () => {
    const abi = abiWith([tupleOf("t", [uint("x"), uint("y")]), str("s")]);
    const outcome = await run({
      ...addressList([CONTRACT], { functionArgs: JSON.stringify([1, 2]) }),
      abiFunction: "f",
      abi,
    });
    expect(outcome.success).toBe(true);
    mockStaticCall.mockClear();
    const [, shared] = await both(abi, [1, "2x"]);
    expect(shared).toBe(
      "Function Arguments has 2 values for f (t, s), which takes 2 when t is an object, or 3 when t is given flat as its 2 members. The same arguments go to every contract in the list."
    );
  });

  it("gives the count when a value given is out of range and another is missing", async () => {
    const abi = abiWith([{ name: "x", type: "uint8" }, str("s")]);
    const [, shared] = await both(abi, ["300"]);
    expect(shared).toBe(
      "Function Arguments has 1 value, but f takes 2 (x, s). The same arguments go to every contract in the list."
    );
  });

  it("names a blank after values that pass, whatever their type", async () => {
    const abi = abiWith([
      { name: "f", type: "bool" },
      { name: "p", type: "uint256[2]" },
      { name: "h", type: "bytes32" },
      { name: "d", type: "bytes" },
      { name: "i", type: "int8" },
      { name: "g", type: "bool" },
    ]);
    const [, shared] = await both(abi, [
      true,
      ["1", "2"],
      `0x${"11".repeat(32)}`,
      "0x12",
      "-3",
    ]);
    expect(shared).toBe(
      "Function Arguments: g: bool cannot be empty. Fill in every argument; only a string may be left blank."
    );
  });

  it("refuses an untouched tuple of strings that also reads as its first member", async () => {
    const abi = abiWith([
      uint("n"),
      tupleOf("x", [str("a"), str("b")]),
      uint("m"),
      str("z"),
    ]);
    // x blank with m = 8, or x = ("", "8") with m = 9: both are valid calls.
    const [, shared] = await both(abi, [7, "", 8, "9"]);
    expect(shared).toMatch(/^Function Arguments: the "" in x's place can be/);
  });

  it("gives the count for an array that lands on a string while a value is missing", async () => {
    const abi = abiWith([
      { name: "i", type: "int8" },
      tupleOf("t", [{ name: "o", type: "bool" }, str("m")]),
      { name: "ss", type: "string[]" },
    ]);
    const [, shared] = await both(abi, [-3, true, ["a", "b"]]);
    expect(shared).toMatch(
      /^Function Arguments has 3 values for f \(i, t, ss\)/
    );
  });

  it("gives the count, fast, when a blank fixed array is too big to stand in for", async () => {
    const abi = abiWith([
      uint("a"),
      { name: "b", type: "uint256[100000][100000]" },
    ]);
    const started = Date.now();
    const [, shared] = await both(abi, [7]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(shared).toBe(
      "Function Arguments has 1 value, but f takes 2 (a, b). The same arguments go to every contract in the list."
    );
  });

  it("names a tuple given as text in a full stored list with a blank at the end", async () => {
    const abi = abiWith([
      uint("x"),
      tupleOf("t", [uint("a"), uint("b")]),
      uint("y"),
    ]);
    const [, shared] = await both(abi, ["7", "[1,2]", ""]);
    expect(shared).toBe(
      'Function Arguments: give t as an object with its member names, like {"a": 1, "b": 1}, not as text.'
    );
  });

  it("gives the count, fast, when many blank fixed arrays add up past one call's data", async () => {
    const abi = abiWith([
      str("s"),
      ...Array.from({ length: 300 }, (_, i) => ({
        name: `a${i}`,
        type: "uint256[2040]",
      })),
    ]);
    const started = Date.now();
    const [, shared] = await both(abi, ["x"]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(shared).toMatch(/^Function Arguments has 1 value, but f takes 301 /);
  });

  it("keeps a flat tuple whose first string member is blank", async () => {
    const abi = abiWith([tupleOf("t", [str("a"), uint("b")]), uint("n")]);
    const outcome = await run({
      ...addressList([CONTRACT], { functionArgs: JSON.stringify(["", 5, 7]) }),
      abiFunction: "f",
      abi,
    });
    expect(outcome.success).toBe(true);
  });

  it("names a blank fixed array padded after values that pass", async () => {
    const abi = abiWith([uint("a"), { name: "b", type: "uint256[2]" }]);
    const [, shared] = await both(abi, [7]);
    expect(shared).toBe(
      "Function Arguments: b: expected array for uint256[2]. Check the arguments for f (a, b)."
    );
  });

  it("gives the count, fast, for a big blank fixed array of empty elements", async () => {
    for (const type of ["uint256[][1000000]", "uint256[0][1000000]"]) {
      const abi = abiWith([uint("a"), { name: "b", type }]);
      const started = Date.now();
      const [, shared] = await both(abi, [7]);
      expect.soft(Date.now() - started, type).toBeLessThan(1000);
      expect
        .soft(shared, type)
        .toMatch(/^Function Arguments has 1 value, but f takes 2 /);
    }
  });

  it("names a lone tuple given as an array before a blank", async () => {
    const abi = abiWith([tupleOf("t", [uint("a"), uint("b")])]);
    const [, shared] = await both(abi, [[1, 2], ""]);
    expect(shared).toBe(
      'Function Arguments: give t as an object with its member names, like {"a": 1, "b": 1}, not as an array.'
    );
  });

  it("names a tuple whose object has mistyped member names", async () => {
    const abi = abiWith([uint("a"), tupleOf("t", [uint("x"), uint("y")])]);
    const [args] = await both(abi, [7, { X: 1, Y: 2 }]);
    expect(args).toMatch(/^Argument Sets entry 1: t\.x/);
  });

  it("pads an untouched array field in the middle of Function Arguments", async () => {
    const abi = abiWith([
      { name: "ids", type: "uint256[]" },
      tupleOf("t", [uint("a"), uint("b")]),
      uint("y"),
    ]);
    // The editor stores an untouched middle field as "" and drops one at the end.
    const [, shared] = await both(abi, ["", { a: "1", b: "2" }]);
    expect(shared).toBe(
      "Function Arguments: ids: expected array for uint256[]. Check the arguments for f (ids, t, y)."
    );
  });

  it("names an untouched tuple starting with a tuple in Function Arguments", async () => {
    const abi = abiWith([
      tupleOf("t", [tupleOf("i", [uint("p")])]),
      uint("x"),
      uint("y"),
    ]);
    // "" in a tuple's place is the tuple left blank, its members blank too.
    const [, shared] = await both(abi, ["", "7"]);
    expect(shared).toBe(
      "Function Arguments: t.i.p: uint256 cannot be empty. Fill in every argument; only a string may be left blank."
    );
  });

  // A correct entry with one value dropped, two neighbours swapped, a value
  // added, or a tuple's object given twice: a message may name only an input
  // the change touched; anything else gets the count. With a value dropped, "cannot be
  // empty" may name a later input: the editor leaves untouched fields out.
  it("names only an input the mistake touched, over many shapes", async () => {
    type Param = { name: string; type: string; components?: Param[] };
    const addr = (name: string): Param => ({ name, type: "address" });
    const arr = (name: string): Param => ({ name, type: "uint256[]" });
    const bool = (name: string): Param => ({ name, type: "bool" });
    const b32 = (name: string): Param => ({ name, type: "bytes32" });
    const bytes = (name: string): Param => ({ name, type: "bytes" });
    const tup = (name: string, components: Param[]): Param => ({
      name,
      type: "tuple",
      components,
    });
    const shapes: Param[][] = [
      [uint("a"), str("s"), tup("t", [uint("x"), uint("y")])],
      [str("s"), uint("n"), tup("t", [uint("x")])],
      [uint("a"), uint("b"), addr("c")],
      [uint("x"), tup("t", [uint("a"), arr("b")]), uint("y")],
      [tup("t", [uint("a"), uint("b")]), uint("x"), uint("y")],
      [tup("t", [tup("i", [uint("p")])]), uint("x"), uint("y")],
      [str("o"), tup("s", [uint("a"), arr("b")])],
      [uint("x"), tup("t", [uint("a"), uint("b")]), arr("ids")],
      [tup("t", [uint("a"), uint("b")]), tup("u", [uint("a"), uint("b")])],
      [addr("o"), tup("t", [str("a"), uint("b")]), str("m")],
      [bool("f"), tup("t", [uint("a"), str("b")]), uint("z")],
      [uint("x"), tup("t", [tup("i", [uint("p")])]), arr("ids")],
      [
        tup("t", [tup("i", [uint("p")])]),
        tup("s", [uint("a"), uint("b")]),
        uint("y"),
      ],
      [str("a"), str("b"), tup("t", [uint("x"), uint("y")])],
      [uint("a"), addr("c"), uint("b")],
      [uint("a"), uint("b"), b32("h"), str("s")],
      [bytes("d"), uint("n"), tup("t", [b32("h"), uint("v")])],
      [
        str("memo"),
        tup("t", [addr("owner"), uint("amount")]),
        uint("deadline"),
      ],
      [bytes("b"), tup("t", [b32("h"), uint("n")]), bytes("c")],
      [
        uint("a"),
        uint("b"),
        tup("t", [uint("x"), uint("y")]),
        str("s"),
        uint("n"),
      ],
      [uint("n"), tup("t", [uint("x"), str("q")])],
      [
        uint("z"),
        tup("t", [uint("a"), tup("i", [uint("p"), uint("q")])]),
        uint("w"),
      ],
    ];
    const sample = (param: Param): unknown => {
      if (param.components) {
        return Object.fromEntries(
          param.components.map((member) => [member.name, sample(member)])
        );
      }
      const samples: Record<string, unknown> = {
        string: "txt",
        address: CONTRACT,
        bool: true,
        "uint256[]": [1, 2],
        bytes32: `0x${"11".repeat(32)}`,
        bytes: "0x1234",
      };
      return samples[param.type] ?? 7;
    };
    // Every correct entry: each tuple as an object or, where it can, flat.
    const entries = (
      inputs: Param[]
    ): { values: unknown[]; owner: string[] }[] =>
      inputs.reduce<{ values: unknown[]; owner: string[] }[]>(
        (done, input) =>
          done.flatMap(({ values, owner }) => {
            const whole = {
              values: [...values, sample(input)],
              owner: [...owner, input.name],
            };
            const members = input.components ?? [];
            if (members.length === 0 || members[0].components) {
              return [whole];
            }
            return [
              whole,
              {
                values: [...values, ...members.map(sample)],
                owner: [...owner, ...members.map(() => input.name)],
              },
            ];
          }),
        [{ values: [], owner: [] }]
      );
    const named =
      /^(?:Argument Sets entry 1|Function Arguments): (?:give )?(\w+)/;
    const wrong: string[] = [];
    for (const inputs of shapes) {
      const abi = abiWith(inputs);
      for (const { values, owner } of entries(inputs)) {
        const mistakes: {
          entry: unknown[];
          touched: string[];
          dropped?: true;
        }[] = [];
        for (const [k, name] of owner.entries()) {
          mistakes.push({
            entry: values.filter((_, i) => i !== k),
            touched: [name],
            dropped: true,
          });
          // A value added before this one.
          for (const extra of [7, "txt", {}]) {
            mistakes.push({
              entry: [...values.slice(0, k), extra, ...values.slice(k)],
              touched: [owner[k - 1] ?? name, name],
            });
          }
          // A tuple's object given twice.
          if (
            inputs.some((p) => p.name === name && p.components) &&
            owner[k - 1] !== name &&
            owner[k + 1] !== name
          ) {
            mistakes.push({
              entry: [
                ...values.slice(0, k + 1),
                values[k],
                ...values.slice(k + 1),
              ],
              touched: [name, owner[k + 1] ?? name],
            });
          }
          if (k + 1 < owner.length && owner[k + 1] !== name) {
            const swapped = [...values];
            [swapped[k], swapped[k + 1]] = [swapped[k + 1], swapped[k]];
            mistakes.push({ entry: swapped, touched: [name, owner[k + 1]] });
          }
        }
        for (const { entry, touched, dropped } of mistakes) {
          // Some mistakes still make a valid call (two numbers swapped).
          const outcomes = [
            await run({ ...argsList([entry], "f"), abi }),
            await run({
              ...addressList([CONTRACT], {
                functionArgs: JSON.stringify(entry),
              }),
              abiFunction: "f",
              abi,
            }),
          ];
          for (const message of outcomes.map((o) => o.error ?? "")) {
            const input = named.exec(message)?.[1];
            if (
              input &&
              !touched.includes(input) &&
              !(dropped && message.includes("cannot be empty"))
            ) {
              wrong.push(`${JSON.stringify(entry)} -> ${message}`);
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("batch-read-contract - seventh review", () => {
  const abiWith = (inputs: unknown[]): string =>
    JSON.stringify([
      {
        name: "f",
        type: "function",
        stateMutability: "view",
        inputs,
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
  const str = (name: string): { name: string; type: string } => ({
    name,
    type: "string",
  });
  const typed = (
    name: string,
    type: string
  ): { name: string; type: string } => ({ name, type });
  const tupleOf = (
    name: string,
    components: { name: string; type: string }[]
  ): {
    name: string;
    type: string;
    components: { name: string; type: string }[];
  } => ({ name, type: "tuple", components });
  const AMBIGUOUS = /can be it left blank or its first member/;

  // The arguments the one call sent, or undefined when nothing was sent.
  const sent = async (
    abi: string,
    functionArgs: unknown[]
  ): Promise<{ args?: unknown[]; error?: string }> => {
    mockStaticCall.mockClear();
    const outcome = await run({
      ...addressList([CONTRACT], {
        functionArgs: JSON.stringify(functionArgs),
      }),
      abiFunction: "f",
      abi,
    });
    if (!outcome.success) {
      return { error: outcome.error };
    }
    const [call] = mockStaticCall.mock.calls[0][0] as Call[];
    return {
      args: new ethers.Interface(abi)
        .decodeFunctionData("f", call.callData)
        .toArray(true),
    };
  };

  it("reads a lone flat tuple with a blank first member and a trimmed blank", async () => {
    const abi = abiWith([tupleOf("n0", [str("a"), str("b"), str("c")])]);
    expect(await sent(abi, ["", "x"])).toEqual({ args: [["", "x", ""]] });
    expect(await sent(abi, ["", "x", ""])).toEqual({ args: [["", "x", ""]] });
  });

  it("refuses when the flat and the blank-tuple readings both line up and differ", async () => {
    const abi = abiWith([
      typed("n0", "uint256[]"),
      tupleOf("n1", [str("n2"), str("n3"), str("n4"), str("n5")]),
      str("n6"),
      tupleOf("n7", [str("n8")]),
      str("n9"),
    ]);
    const { error } = await sent(abi, [[], "", " [x] ", "[1]", "hi"]);
    expect(error).toBe(
      'Function Arguments: the "" in n1\'s place can be it left blank or its first member, and the values after it are read differently. Give n1 as an object with its member names, like {"n2": "...", "n3": "...", "n4": "...", "n5": "..."}.'
    );
    // Given as an object, it is sent as written.
    expect(
      await sent(abi, [[], { n2: "", n3: " [x] ", n4: "[1]", n5: "hi" }])
    ).toEqual({ args: [[], ["", " [x] ", "[1]", "hi"], "", [""], ""] });
  });

  it("refuses an untouched tuple of strings before values that also read flat", async () => {
    const abi = abiWith([
      typed("n", "uint256"),
      tupleOf("x", [str("a"), str("b")]),
      typed("m", "uint256"),
      str("z"),
    ]);
    expect((await sent(abi, [7, "", 8, "9"])).error).toMatch(AMBIGUOUS);
    expect(await sent(abi, [7, { a: "", b: "" }, 8, "9"])).toEqual({
      args: [BigInt(7), ["", ""], BigInt(8), "9"],
    });
  });

  it("accepts a blank tuple when both readings send the same values", async () => {
    const abi = abiWith([tupleOf("t", [str("a"), str("b")]), str("s")]);
    for (const entry of [[""], ["", ""], ["", "", ""]]) {
      expect.soft(await sent(abi, entry), JSON.stringify(entry)).toEqual({
        args: [["", ""], ""],
      });
    }
  });

  it("reads an untouched tuple as blank when only that reading lines up", async () => {
    const abi = abiWith([
      tupleOf("t", [str("a"), typed("b", "uint256[]")]),
      typed("n", "uint256"),
    ]);
    // Flat, 7 would land on t.b, an array: only the blank reading fits.
    const { error } = await sent(abi, ["", "7"]);
    expect(error).not.toMatch(AMBIGUOUS);
    expect(error).toMatch(/^Function Arguments: t\.b/);
  });

  // Correct flat entries whose tuple starts with a blank string, with the
  // untouched strings at the end left out: each is sent as read flat, or
  // refused as ambiguous, never sent any other way.
  it("sends a flat tuple with a blank first member as given, or refuses, over many shapes", async () => {
    const pool: { name: string; type: string }[] = [
      typed("u", "uint256"),
      str("s"),
      typed("ss", "string[]"),
      typed("us", "uint256[]"),
      typed("ok", "bool"),
    ];
    const tuples = [
      [str("a"), str("b")],
      [str("a"), typed("b", "uint256")],
      [str("a"), str("b"), str("c")],
      [str("a")],
    ];
    const sample = (type: string, k: number): unknown => {
      switch (type) {
        case "uint256":
          return String(k + 1);
        case "string":
          return `v${k}`;
        case "string[]":
          return [`w${k}`];
        case "uint256[]":
          return [String(k + 2)];
        default:
          return true;
      }
    };
    const decoded = (type: string, value: unknown): unknown => {
      if (type === "uint256") {
        return BigInt(value as string);
      }
      if (type === "uint256[]") {
        return (value as string[]).map((v) => BigInt(v));
      }
      return value;
    };
    let flat = 0;
    let refused = 0;
    for (const before of [[], ...pool.map((p) => [p])]) {
      for (const components of tuples) {
        for (const after of [
          [],
          ...pool.map((p) => [p]),
          ...pool.map((p) => [p, str("z")]),
          [str("y"), tupleOf("q", [str("q1")])],
        ]) {
          const inputs = [
            ...before,
            tupleOf(
              "t",
              components.map((c) => ({ ...c }))
            ),
            ...after,
          ];
          // The last blankLast inputs, plain strings, are left blank too.
          for (const blankLast of [0, 1, 2]) {
            const tail = inputs.slice(inputs.length - blankLast);
            if (
              blankLast > after.length ||
              tail.some((input) => input.type !== "string")
            ) {
              continue;
            }
            const abi = abiWith(inputs);
            const values: unknown[] = [];
            const expected: unknown[] = [];
            let k = 0;
            for (const [index, input] of inputs.entries()) {
              const members: { name: string; type: string }[] =
                "components" in input
                  ? (input.components as { name: string; type: string }[])
                  : [input];
              const blank = index >= inputs.length - blankLast;
              const decodedMembers = members.map((member, m) => {
                const value =
                  blank || (input.name === "t" && m === 0)
                    ? ""
                    : sample(member.type, k);
                k += 1;
                values.push(value);
                return decoded(member.type, value);
              });
              expected.push(
                "components" in input ? decodedMembers : decodedMembers[0]
              );
            }
            // The editor leaves untouched strings at the end out.
            let end = values.length;
            while (end > 0 && values[end - 1] === "") {
              end -= 1;
            }
            const label = `${JSON.stringify(inputs)} ${JSON.stringify(values)}`;
            const outcome = await sent(abi, values.slice(0, end));
            if (outcome.error) {
              refused += 1;
              expect.soft(outcome.error, label).toMatch(AMBIGUOUS);
            } else {
              flat += 1;
              expect.soft(outcome.args, label).toEqual(expected);
            }
          }
        }
      }
    }
    expect(flat).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(5);
  });
});
