/**
 * The direct-execute catch-all route (app/api/execute/[...slug]/route.ts)
 * must run the same encode transforms the workflow step runs, on both the
 * ABI args and the payable value, or the two entrances disagree on what a
 * LayerZero OFT send actually sends: the label says wei, the step converts
 * wei, and a route that did not would broadcast 10^18 times the fee and
 * hand the OFT a 20-byte recipient in a bytes32 slot.
 *
 * The registry mock returns the real LayerZero definition so the assertions
 * run against the production registrations (padAddressToBytes on
 * oft-send/to, weiToEther on oft-send/ethValue). A synthetic action with no
 * transforms pins the other half: such an action must reach
 * writeContractCore and the cap byte-for-byte as it did before.
 */

import { Interface, parseEther } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  coerceArgsForAbi,
  type FunctionAbiEntry,
  reshapeArgsForAbi,
} from "@/lib/abi/struct-args";

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));

import chainlinkDef from "@/protocols/chainlink";
import layerzeroDef from "@/protocols/layerzero";

const getProtocolMock = vi.fn();
vi.mock("@/lib/protocol-registry", () => ({
  getProtocol: (slug: string) => getProtocolMock(slug),
  resolveContractAddress: (
    contract: {
      userSpecifiedAddress?: boolean;
      addresses: Record<string, string>;
    },
    network: string,
    providedAddress: string | undefined
  ) =>
    contract.userSpecifiedAddress
      ? providedAddress
      : contract.addresses[network],
}));

vi.mock("../../app/api/execute/_lib/auth", () => ({
  validateApiKey: vi
    .fn()
    .mockResolvedValue({ organizationId: "org_1", apiKeyId: "key_1" }),
}));
vi.mock("../../app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));
vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: vi.fn(),
}));
vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: vi.fn().mockResolvedValue({ abi: "[]", source: "definition" }),
}));

const resolveProtocolMetaMock = vi.fn();
vi.mock("@/plugins/protocol/steps/resolve-protocol-meta", () => ({
  resolveProtocolMeta: (input: unknown) => resolveProtocolMetaMock(input),
}));

const writeContractCoreMock = vi.fn();
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (input: unknown) => writeContractCoreMock(input),
}));
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: vi.fn(),
}));
vi.mock("@/lib/step-registry", () => ({
  PLUGIN_STEP_IMPORTERS: {
    "layerzero/oft-send": () => Promise.resolve({}),
    "test-protocol/supply": () => Promise.resolve({}),
  },
}));
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi.fn().mockResolvedValue({ blocked: false }),
}));
vi.mock("../../app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));

const checkAndReserveExecutionMock = vi.fn();
vi.mock("../../app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: (params: unknown) =>
    checkAndReserveExecutionMock(params),
}));
vi.mock("../../app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../app/api/execute/_lib/execution-service", () => ({
  markRunning: vi.fn(),
  completeExecution: vi.fn().mockResolvedValue({ status: "completed" }),
  failExecution: vi.fn(),
  redactInput: (x: unknown) => x,
  withRejectedSignerOverride: (a: unknown) => a,
}));
const recordIdempotentResponseMock = vi.fn(
  (_outcome: unknown, response: Response, _disposition?: string) =>
    Promise.resolve(response)
);
vi.mock("@/lib/idempotency", () => ({
  beginIdempotentFromRequest: vi.fn().mockResolvedValue({ kind: "proceed" }),
  idempotencyEarlyResponse: vi.fn().mockReturnValue(null),
  recordIdempotentResponse: (
    outcome: unknown,
    response: Response,
    disposition?: string
  ) => recordIdempotentResponseMock(outcome, response, disposition),
  withIdempotencyHeartbeat: (_outcome: unknown, fn: () => unknown) => fn(),
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const ADAPTER = "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee";
const FEE_WEI = "218756042576226";
const PADDED_WALLET = `0x${"0".repeat(24)}${WALLET.slice(2)}`;

const OFT_SEND_META = {
  protocolSlug: "layerzero",
  contractKey: "oft",
  functionName: "send",
  actionType: "write",
};
const SUPPLY_META = {
  protocolSlug: "test-protocol",
  contractKey: "pool",
  functionName: "supply",
  actionType: "write",
};
// A payable action with no transforms registered under its slug.
const SUPPLY_PROTOCOL = {
  slug: "test-protocol",
  contracts: { pool: { addresses: { "1": "0xPool" } } },
  actions: [
    {
      slug: "supply",
      function: "supply",
      contract: "pool",
      payable: true,
      inputs: [
        { name: "asset", type: "address", label: "Asset" },
        { name: "amount", type: "uint256", label: "Amount" },
      ],
    },
  ],
};

async function post(slug: string[], body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/execute/[...slug]/route");
  const req = new Request(`http://test/api/execute/${slug.join("/")}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: "Bearer x" },
  });
  return POST(req, { params: Promise.resolve({ slug }) });
}

function sendBody(ethValue: unknown): Record<string, unknown> {
  return {
    chainId: 1,
    contractAddress: ADAPTER,
    dstEid: "30110",
    to: WALLET,
    amountLD: "1000000",
    minAmountLD: "990000",
    nativeFee: FEE_WEI,
    lzTokenFee: "0",
    refundAddress: WALLET,
    ethValue,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  checkAndReserveExecutionMock.mockResolvedValue({
    allowed: true,
    executionId: "exec_1",
  });
  writeContractCoreMock.mockResolvedValue({
    success: true,
    transactionHash: "0xtx",
    chainId: 1,
    transactionLink: "https://scan/0xtx",
    gasUsed: "21000",
    effectiveGasPrice: "1000000000",
  });
});

describe("direct-execute route: encode transforms on a protocol write", () => {
  it("converts the wei value field to ether for both the cap and the core write, and pads the recipient", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(["layerzero", "oft-send"], sendBody(FEE_WEI));

    expect(response.status).toBe(202);
    // The cap is charged the wei the caller typed, not 10^18 times it.
    expect(checkAndReserveExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reserved: { kind: "evm", valueWei: FEE_WEI },
      })
    );
    const core = writeContractCoreMock.mock.calls[0][0] as {
      ethValue: string;
      functionArgs: string;
    };
    expect(core.ethValue).toBe("0.000218756042576226");
    expect(parseEther(core.ethValue)).toBe(BigInt(FEE_WEI));
    const args = JSON.parse(core.functionArgs) as string[];
    // Flattened SendParam, then MessagingFee, then refundAddress; `to` is
    // the padded bytes32 the OFT expects, and nativeFee is the raw wei.
    expect(args).toEqual([
      "30110",
      PADDED_WALLET,
      "1000000",
      "990000",
      "0x00030100110100000000000000000000000000030d40",
      "0x",
      "0x",
      FEE_WEI,
      "0",
      WALLET,
    ]);
  });

  it("accepts the wei value as a JSON number when it is a safe integer", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(
      ["layerzero", "oft-send"],
      sendBody(Number(FEE_WEI))
    );

    expect(response.status).toBe(202);
    expect(checkAndReserveExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reserved: { kind: "evm", valueWei: FEE_WEI },
      })
    );
  });

  it("refuses a wei value sent as a number that cannot carry exact digits", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(["layerzero", "oft-send"], sendBody(1e21));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/JSON number/);
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(writeContractCoreMock).not.toHaveBeenCalled();
    expect(recordIdempotentResponseMock.mock.calls[0][2]).toBe("release");
  });

  it("refuses ether typed into the wei field before reserving or broadcasting", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    // weiToEther throws on a non-integer; the route surfaces it as the
    // caller's error (400, key released) rather than a 500, and never
    // sends 0.01 wei or 0.01 ether.
    const response = await post(["layerzero", "oft-send"], sendBody("0.01"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/integer wei/);
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(writeContractCoreMock).not.toHaveBeenCalled();
    expect(recordIdempotentResponseMock.mock.calls[0][2]).toBe("release");
  });

  it("fails closed with a named error when the action cannot be resolved and a value is present", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    // Stale metadata: the function no longer matches a registered action.
    resolveProtocolMetaMock.mockReturnValue({
      ...OFT_SEND_META,
      functionName: "sendRenamedUpstream",
    });

    const response = await post(["layerzero", "oft-send"], sendBody(FEE_WEI));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(
      /Refusing to send a payable value/
    );
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(writeContractCoreMock).not.toHaveBeenCalled();
    expect(recordIdempotentResponseMock.mock.calls[0][2]).toBe("release");
  });

  it("leaves an action with no registered transforms byte-for-byte as before", async () => {
    getProtocolMock.mockReturnValue(SUPPLY_PROTOCOL);
    resolveProtocolMetaMock.mockReturnValue(SUPPLY_META);

    const response = await post(["test-protocol", "supply"], {
      chainId: 1,
      asset: WALLET,
      amount: "1000",
      ethValue: "0.25",
    });

    expect(response.status).toBe(202);
    expect(checkAndReserveExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reserved: { kind: "evm", valueWei: parseEther("0.25").toString() },
      })
    );
    const core = writeContractCoreMock.mock.calls[0][0] as {
      ethValue: string;
      functionArgs: string;
    };
    expect(core.ethValue).toBe("0.25");
    expect(JSON.parse(core.functionArgs)).toEqual([WALLET, "1000"]);
  });

  it("still forwards a numeric ether value on an action with no transforms as its string", async () => {
    getProtocolMock.mockReturnValue(SUPPLY_PROTOCOL);
    resolveProtocolMetaMock.mockReturnValue(SUPPLY_META);

    const response = await post(["test-protocol", "supply"], {
      chainId: 1,
      asset: WALLET,
      amount: "1000",
      ethValue: 0.25,
    });

    expect(response.status).toBe(202);
    const core = writeContractCoreMock.mock.calls[0][0] as { ethValue: string };
    expect(core.ethValue).toBe("0.25");
  });

  // padAddressToBytes left-pads whatever it is given, so an address that
  // is not an address must be refused BEFORE the pad turns it into a
  // well-formed bytes32. Each case: 400, no reservation, no broadcast.
  it.each([
    ["a 39-character address", `0x${"1".repeat(39)}`],
    ["a bare 0x", "0x"],
    ["non-hex characters", `0x${"g".repeat(40)}`],
    ["a 41-character address", `0x${"1".repeat(41)}`],
    ["a missing 0x prefix", "1".repeat(40)],
  ])(
    "refuses %s as the OFT recipient before padding it",
    async (_label, to) => {
      getProtocolMock.mockReturnValue(layerzeroDef);
      resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

      const response = await post(["layerzero", "oft-send"], {
        ...sendBody(FEE_WEI),
        to,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("to");
      expect(data.error).toMatch(/Invalid address for field to/);
      expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
      expect(writeContractCoreMock).not.toHaveBeenCalled();
      expect(recordIdempotentResponseMock.mock.calls[0][2]).toBe("release");
    }
  );

  it("covers the Chainlink CCIP receiver, the other padded address, in the args builder", async () => {
    getProtocolMock.mockReturnValue(chainlinkDef);
    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const send = chainlinkDef.actions.find((a) => a.slug === "ccip-send");
    if (!send) {
      throw new Error("chainlink/ccip-send not in definition");
    }
    const inputs = Object.fromEntries(
      send.inputs.map((inp) => [
        inp.name,
        inp.type === "address" ? WALLET : (inp.default ?? "1"),
      ])
    );

    const bad = buildProtocolFunctionArgs(
      { ...inputs, receiver: `0x${"1".repeat(39)}` },
      "chainlink",
      send.contract,
      send.function
    );
    expect(bad).toEqual({
      ok: false,
      field: "receiver",
      error: expect.stringMatching(/Invalid address for field receiver/),
    });

    const good = buildProtocolFunctionArgs(
      inputs,
      "chainlink",
      send.contract,
      send.function
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      const args = JSON.parse(good.functionArgs ?? "[]") as string[];
      expect(args).toContain(PADDED_WALLET);
    }
  });

  // Before this route applied transforms, a padded input could only be
  // satisfied by the 32-byte value itself (ethers rejects 20 bytes for a
  // bytes32 slot), so that is what every working caller sends today. It
  // must keep working, and produce the exact calldata origin/staging
  // produced: the raw value forwarded verbatim into the encoder.
  it("keeps accepting an already-encoded bytes32 CCIP receiver, with byte-identical calldata", async () => {
    getProtocolMock.mockReturnValue(chainlinkDef);
    const { buildProtocolFunctionArgs } = await import(
      "@/app/api/execute/_lib/protocol-function-args"
    );
    const send = chainlinkDef.actions.find((a) => a.slug === "ccip-send");
    if (!send) {
      throw new Error("chainlink/ccip-send not in definition");
    }
    const inputs = Object.fromEntries(
      send.inputs.map((inp) => [
        inp.name,
        inp.type === "address"
          ? WALLET
          : inp.type.endsWith("[]")
            ? []
            : (inp.default ?? "1"),
      ])
    );
    const encoded: Record<string, unknown> = {
      ...inputs,
      receiver: PADDED_WALLET,
    };

    const result = buildProtocolFunctionArgs(
      encoded,
      "chainlink",
      send.contract,
      send.function
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const newArgs = JSON.parse(result.functionArgs ?? "[]") as string[];
    // What origin/staging forwarded: every input verbatim, in order (an
    // array input as its JSON string, as resolveInputValue has always done).
    const stagingArgs = send.inputs.map((inp) => {
      const v = encoded[inp.name];
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
    expect(newArgs).toEqual(stagingArgs);

    // And through the same reshape/coerce/encode pipeline
    // writeContractCore runs, the calldata is identical.
    const iface = new Interface(
      JSON.parse(chainlinkDef.contracts[send.contract].abi as string)
    );
    const fragment = iface.getFunction(send.function);
    if (!fragment) {
      throw new Error("ccipSend fragment missing");
    }
    const abi = JSON.parse(fragment.format("json")) as FunctionAbiEntry;
    // Array params arrive as JSON strings on both sides; parse them the
    // way the core does before reshaping.
    const parseArrays = (args: unknown[]) =>
      args.map((a) =>
        typeof a === "string" && a.startsWith("[") ? JSON.parse(a) : a
      );
    const calldataFor = (args: unknown[]) =>
      iface.encodeFunctionData(
        fragment,
        coerceArgsForAbi(reshapeArgsForAbi(parseArrays(args), abi), abi)
      );
    expect(calldataFor(newArgs)).toBe(calldataFor(stagingArgs));
  });

  it.each([
    ["63 hex characters", `0x${"1".repeat(63)}`],
    ["65 hex characters", `0x${"1".repeat(65)}`],
    ["39 hex characters", `0x${"1".repeat(39)}`],
    ["a bare 0x", "0x"],
    ["64 non-hex characters", `0x${"g".repeat(64)}`],
  ])(
    "refuses %s as the CCIP receiver, neither an address nor a bytes32",
    async (_label, receiver) => {
      getProtocolMock.mockReturnValue(chainlinkDef);
      const { buildProtocolFunctionArgs } = await import(
        "@/app/api/execute/_lib/protocol-function-args"
      );
      const send = chainlinkDef.actions.find((a) => a.slug === "ccip-send");
      if (!send) {
        throw new Error("chainlink/ccip-send not in definition");
      }
      const inputs = Object.fromEntries(
        send.inputs.map((inp) => [
          inp.name,
          inp.type === "address" ? WALLET : (inp.default ?? "1"),
        ])
      );
      expect(
        buildProtocolFunctionArgs(
          { ...inputs, receiver },
          "chainlink",
          send.contract,
          send.function
        )
      ).toMatchObject({ ok: false, field: "receiver" });
    }
  );

  it("accepts an already-encoded bytes32 OFT recipient untouched, on the route", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(["layerzero", "oft-send"], {
      ...sendBody(FEE_WEI),
      to: PADDED_WALLET,
    });

    expect(response.status).toBe(202);
    const core = writeContractCoreMock.mock.calls[0][0] as {
      functionArgs: string;
    };
    expect((JSON.parse(core.functionArgs) as string[])[1]).toBe(PADDED_WALLET);
  });

  it.each([
    ["63 hex characters", `0x${"1".repeat(63)}`],
    ["65 hex characters", `0x${"1".repeat(65)}`],
  ])("refuses %s as the OFT recipient on the route", async (_label, to) => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(["layerzero", "oft-send"], {
      ...sendBody(FEE_WEI),
      to,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("to");
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
    expect(writeContractCoreMock).not.toHaveBeenCalled();
  });

  it("does not extend the bytes32 shape to an address input with no transform", async () => {
    // refundAddress is a plain address param: the ABI encoder never took
    // 32 bytes for it, so neither does the route.
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(["layerzero", "oft-send"], {
      ...sendBody(FEE_WEI),
      refundAddress: PADDED_WALLET,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("refundAddress");
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed refundAddress too (an address input with no transform)", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(["layerzero", "oft-send"], {
      ...sendBody(FEE_WEI),
      refundAddress: "0x1234",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("refundAddress");
    expect(checkAndReserveExecutionMock).not.toHaveBeenCalled();
  });

  it("sends no value and reserves zero when the value is absent, on either kind of action", async () => {
    getProtocolMock.mockReturnValue(layerzeroDef);
    resolveProtocolMetaMock.mockReturnValue(OFT_SEND_META);

    const response = await post(["layerzero", "oft-send"], sendBody(undefined));

    expect(response.status).toBe(202);
    expect(checkAndReserveExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ reserved: { kind: "evm", valueWei: "0" } })
    );
    const core = writeContractCoreMock.mock.calls[0][0] as {
      ethValue: unknown;
    };
    expect(core.ethValue).toBeUndefined();
  });
});
