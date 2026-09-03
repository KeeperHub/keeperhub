import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ explorerConfigs: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: (): string => "",
  getTransactionUrl: (): string => "",
}));

import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";

const SEQUENCER_ADDRESS = "0xdA0Ab1e0017DEbCd72Be8599041a2aa3bA7e740F";
const D3M_JOB_ADDRESS = "0x2Ea4aDE144485895B923466B4521F5ebC03a0AeF";
const TOKEN_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const HOLDER_ADDRESS = "0x2c9F694183A4240B6431771F6c714a8106179dF5";
const CRON_D3M_JOB_KEY =
  "0x43524f4e5f44334d5f4a4f420000000000000000000000000000000000000000";

const COLLIDING_NAMES = [
  "getAddress",
  "connect",
  "attach",
  "queryFilter",
  "getEvent",
] as const;

function buildAbiFor(name: string): unknown[] {
  return [
    {
      type: "function",
      name,
      stateMutability: "view",
      inputs: [{ name: "_key", type: "bytes32" }],
      outputs: [{ name: "addr", type: "address" }],
    },
  ];
}

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type ExecuteWithFailover = <T>(
  op: (provider: unknown) => Promise<T>
) => Promise<T>;

function createAdapter(): EvmChainAdapter {
  const gasStrategy = { getGasConfig: vi.fn() };
  const nonceManager = { getNextNonce: vi.fn() };
  return new EvmChainAdapter(
    1,
    gasStrategy as unknown as ConstructorParameters<typeof EvmChainAdapter>[1],
    nonceManager as unknown as ConstructorParameters<typeof EvmChainAdapter>[2]
  );
}

function createRpcManagerWithCallReturning(rawResult: string): {
  executeWithFailover: ExecuteWithFailover;
  callMock: ReturnType<typeof vi.fn>;
} {
  const callMock = vi.fn().mockResolvedValue(rawResult);
  const provider = { call: callMock };
  const executeWithFailover: ExecuteWithFailover = async (op) =>
    await op(provider);
  return { executeWithFailover, callMock };
}

type ReadContractRequest = Parameters<EvmChainAdapter["readContract"]>[1];
type RpcProviderManagerArg = Parameters<EvmChainAdapter["readContract"]>[0];

describe("EvmChainAdapter.readContract — BaseContract name collision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(
    COLLIDING_NAMES
  )("returns the ABI function result for `%s` (bare name), not the contract address", async (name) => {
    const adapter = createAdapter();
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address"],
      [D3M_JOB_ADDRESS]
    );
    const { executeWithFailover, callMock } =
      createRpcManagerWithCallReturning(encoded);

    const result = (await adapter.readContract(
      { executeWithFailover } as unknown as RpcProviderManagerArg,
      {
        contractAddress: SEQUENCER_ADDRESS,
        abi: buildAbiFor(name) as unknown as ethers.InterfaceAbi,
        functionKey: name,
        args: [CRON_D3M_JOB_KEY],
        isView: true,
      } as ReadContractRequest
    )) as string;

    expect(callMock).toHaveBeenCalledTimes(1);
    expect(ethers.getAddress(result)).toBe(ethers.getAddress(D3M_JOB_ADDRESS));
    expect(ethers.getAddress(result)).not.toBe(
      ethers.getAddress(SEQUENCER_ADDRESS)
    );
  });

  it("uses staticCall when isView is false (nonpayable read with colliding name)", async () => {
    const adapter = createAdapter();
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address"],
      [D3M_JOB_ADDRESS]
    );
    const { executeWithFailover, callMock } =
      createRpcManagerWithCallReturning(encoded);

    const result = (await adapter.readContract(
      { executeWithFailover } as unknown as RpcProviderManagerArg,
      {
        contractAddress: SEQUENCER_ADDRESS,
        abi: buildAbiFor("getAddress") as unknown as ethers.InterfaceAbi,
        functionKey: "getAddress",
        args: [CRON_D3M_JOB_KEY],
        isView: false,
      } as ReadContractRequest
    )) as string;

    expect(callMock).toHaveBeenCalledTimes(1);
    expect(ethers.getAddress(result)).toBe(ethers.getAddress(D3M_JOB_ADDRESS));
  });

  it("non-colliding name (`balanceOf`) keeps working — guards against over-broad fix", async () => {
    const adapter = createAdapter();
    const expectedBalance = BigInt("123456789012345678");
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256"],
      [expectedBalance]
    );
    const { executeWithFailover, callMock } =
      createRpcManagerWithCallReturning(encoded);

    const result = (await adapter.readContract(
      { executeWithFailover } as unknown as RpcProviderManagerArg,
      {
        contractAddress: TOKEN_ADDRESS,
        abi: BALANCE_OF_ABI as unknown as ethers.InterfaceAbi,
        functionKey: "balanceOf",
        args: [HOLDER_ADDRESS],
        isView: true,
      } as ReadContractRequest
    )) as bigint;

    expect(callMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(expectedBalance);
  });
});
