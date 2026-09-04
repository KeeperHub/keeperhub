import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const KNOWN_ROUTER = "0x1111111111111111111111111111111111111111";
const UNKNOWN_SPENDER = "0x2222222222222222222222222222222222222222";
const USER_SUPPLIED = "0x3333333333333333333333333333333333333333";

const ORG_WALLET = "0x4444444444444444444444444444444444444444";
const COUNTERPARTY = "0x5555555555555555555555555555555555555555";
const SAFE_WALLET = "0x6666666666666666666666666666666666666666";

const { mockGetOrgWallet } = vi.hoisted(() => ({
  mockGetOrgWallet: vi.fn(),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: mockGetOrgWallet,
}));

vi.mock("@/lib/protocol-registry", () => ({
  getRegisteredProtocols: () => [
    {
      slug: "test-protocol",
      contracts: {
        router: { label: "Router", addresses: { mainnet: KNOWN_ROUTER } },
        // userSpecifiedAddress contracts take their address from the caller at
        // run time, so they must not seed the allowlist.
        custom: {
          label: "Custom",
          addresses: { mainnet: USER_SUPPLIED },
          userSpecifiedAddress: true,
        },
      },
    },
  ],
}));

vi.mock("server-only", () => ({}));

// Hoisted registry rows the fake supported_tokens lookup returns, set per test.
const state = vi.hoisted(() => ({
  tokenRows: [] as Array<{
    tokenAddress: string;
    decimals: number;
    symbol: string;
    isStablecoin: boolean;
  }>,
  selectCalls: 0,
  safeRows: [] as { safeAddress: string }[],
}));

// Fake db serving two reads: the chain's supported_tokens list, which the cap
// matches against in JS, and the org's safe_wallets rows, which feed the payer
// set for transferFrom. Branches on the selected columns, since that is the
// only thing distinguishing the two calls through this stub.
vi.mock("@/lib/db", () => ({
  db: {
    select: (columns?: Record<string, unknown>) => {
      const isSafeQuery = columns !== undefined && "safeAddress" in columns;
      if (!isSafeQuery) {
        state.selectCalls += 1;
      }
      return {
        from: () => ({
          where: () =>
            Promise.resolve(isSafeQuery ? state.safeRows : state.tokenRows),
        }),
      };
    },
  },
}));

import {
  getDefaultBatchStablecoinCapMicroUsd,
  getDefaultStablecoinTransferCapMicroUsd,
} from "@/lib/execute/spend-cap-defaults";
import {
  checkStablecoinCalldata,
  checkStablecoinCalldataBatch,
  checkStablecoinContractCall,
  checkStablecoinTransferAmount,
} from "@/lib/execute/stablecoin-cap";

const CAP_MICRO_USD = BigInt(getDefaultStablecoinTransferCapMicroUsd());
// The cap in whole dollars, used to build amounts either side of it.
const CAP_USD = CAP_MICRO_USD / BigInt(1_000_000);
const BATCH_CAP_MICRO_USD = BigInt(getDefaultBatchStablecoinCapMicroUsd());
const BATCH_CAP_USD = BATCH_CAP_MICRO_USD / BigInt(1_000_000);

// The registry seeds addresses lowercase; callers usually resolve checksummed
// ones, so the two casings must still meet.
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

const USDC = {
  tokenAddress: USDC_ADDRESS.toLowerCase(),
  decimals: 6,
  symbol: "USDC",
  isStablecoin: true,
};
const DAI = {
  tokenAddress: USDC_ADDRESS.toLowerCase(),
  decimals: 18,
  symbol: "DAI",
  isStablecoin: true,
};

const transferParams = {
  organizationId: "org_1",
  chainId: 1,
  tokenAddress: USDC_ADDRESS,
  context: "test",
};

const erc20 = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function deposit(uint256 amount)",
]);

const MEMO = `0x${"0".repeat(64)}`;

/** Base units of a whole-dollar figure at the token's decimals. */
function units(dollars: bigint, decimals: number): string {
  return (dollars * BigInt(10) ** BigInt(decimals)).toString();
}

beforeEach(() => {
  state.tokenRows = [];
  state.selectCalls = 0;
  state.safeRows = [];
  mockGetOrgWallet.mockReset();
  mockGetOrgWallet.mockResolvedValue(ORG_WALLET);
});

describe("the stablecoin per-transaction ceiling", () => {
  // Pinned so widening the policy is a deliberate test edit. Every other case
  // here derives its expectations from the getter.
  it("is 100 USD, expressed in micro-USD", () => {
    expect(getDefaultStablecoinTransferCapMicroUsd()).toBe("100000000");
  });
});

describe("checkStablecoinTransferAmount", () => {
  it("allows a stablecoin transfer exactly at the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: CAP_USD.toString(),
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("allows a routine stablecoin transfer well under the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "25.5",
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("denies a stablecoin transfer one micro-USD over the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: `${CAP_USD}.000001`,
    });

    expect(result.kind).toBe("denied");
  });

  it("denies the drain the native cap could never see", async () => {
    // An ERC-20 call carries a native value of 0, so the daily value cap
    // reserves 0 for it. This is the only thing bounding the transfer.
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "250000",
    });

    expect(result.kind).toBe("denied");
  });

  it("rescales an 18-decimal stablecoin to micro-USD before comparing", async () => {
    state.tokenRows = [DAI];

    const under = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: (CAP_USD - BigInt(1)).toString(),
    });
    expect(under).toEqual({ kind: "allowed" });

    const over = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: (CAP_USD + BigInt(1)).toString(),
    });
    expect(over.kind).toBe("denied");
  });

  it("passes through a registered token that is not a stablecoin", async () => {
    // Pricing an arbitrary ERC-20 needs an oracle in the pre-broadcast path.
    state.tokenRows = [
      {
        tokenAddress: USDC_ADDRESS.toLowerCase(),
        decimals: 18,
        symbol: "WETH",
        isStablecoin: false,
      },
    ];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "1000",
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("passes through a token the registry does not know", async () => {
    state.tokenRows = [];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "1000000",
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("does not query the registry for a malformed token address", async () => {
    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      tokenAddress: "not-an-address",
      amount: "1000000",
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  it("reports an unparseable amount as invalid, not as over cap", async () => {
    // The two must stay distinguishable: one is a 400, the other a policy
    // denial, and collapsing them would make a typo read as "cap exceeded".
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "1.0000001",
    });

    expect(result.kind).toBe("denied");
  });

  it("matches a checksummed address against the lowercase registry row", async () => {
    // An exact-casing comparison would find nothing here, and finding nothing
    // means failing open.
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      tokenAddress: USDC_ADDRESS,
      amount: (CAP_USD + BigInt(1)).toString(),
    });

    expect(result.kind).toBe("denied");
  });

  it("ignores a different token on the same chain", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      tokenAddress: RECIPIENT,
      amount: "1000000",
    });

    expect(result).toEqual({ kind: "allowed" });
  });
});

describe("checkStablecoinContractCall", () => {
  const callParams = {
    organizationId: "org_1",
    chainId: 1,
    contractAddress: USDC_ADDRESS,
    context: "test",
  };

  it("denies a USDC transfer smuggled through the contract-call path", async () => {
    // The bypass the route-level check missed: execute_contract_call takes a
    // caller-supplied address, ABI and args, and reserves 0 native value.
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("denied");
  });

  it("allows a contract-call transfer under the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, units(BigInt(10), 6)],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("reads the amount from the third argument of transferFrom", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transferFrom",
      inputTypes: ["address", "address", "uint256"],
      // Payer is the org wallet, so this is a real outflow.
      args: [ORG_WALLET, RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("denied");
  });

  // A pull payment: the counterparty pays and the org collects. Value moves
  // INTO the wallet, so the outflow ceiling has nothing to say about it.
  // Treating every transferFrom as an outflow refused invoice settlements.
  it("allows an over-cap transferFrom that collects from a counterparty", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transferFrom",
      inputTypes: ["address", "address", "uint256"],
      args: [COUNTERPARTY, ORG_WALLET, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  // The EOA is not the only address the org can move funds from. A
  // transferFrom naming a Safe as payer would otherwise compare unequal, read
  // as an inbound collection and skip the ceiling. Not a drain in the ordinary
  // case -- pulling from your own balance needs allowance[safe][safe], which is
  // zero -- but it becomes one where a Safe has approved the org EOA as a
  // spender, and nothing in this module checks allowances.
  it("applies the ceiling when the payer is a Safe the org controls", async () => {
    state.tokenRows = [USDC];
    state.safeRows = [{ safeAddress: SAFE_WALLET }];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transferFrom",
      inputTypes: ["address", "address", "uint256"],
      args: [SAFE_WALLET, RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("denied");
  });

  it("still exempts a counterparty payer when the org has Safes", async () => {
    state.tokenRows = [USDC];
    state.safeRows = [{ safeAddress: SAFE_WALLET }];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transferFrom",
      inputTypes: ["address", "address", "uint256"],
      args: [COUNTERPARTY, ORG_WALLET, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("compares the payer case-insensitively", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transferFrom",
      inputTypes: ["address", "address", "uint256"],
      args: [
        ORG_WALLET.toUpperCase().replace("0X", "0x"),
        RECIPIENT,
        units(CAP_USD + BigInt(1), 6),
      ],
    });

    expect(result.kind).toBe("denied");
  });

  // Fail closed: an unresolvable wallet must not become a way to move funds
  // out under a transferFrom the check can no longer attribute.
  it("still applies the ceiling when the org wallet cannot be resolved", async () => {
    state.tokenRows = [USDC];
    mockGetOrgWallet.mockRejectedValue(new Error("wallet lookup failed"));

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transferFrom",
      inputTypes: ["address", "address", "uint256"],
      args: [COUNTERPARTY, ORG_WALLET, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("denied");
  });

  // transfer has no payer argument -- it always moves from the caller -- so
  // the payer exemption must not leak into it via args[0], which is the payee.
  it("does not exempt a plain transfer whose recipient is a counterparty", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [COUNTERPARTY, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("denied");
  });

  it("accepts a bigint argument as well as a decimal string", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, BigInt(units(CAP_USD + BigInt(1), 6))],
    });

    expect(result.kind).toBe("denied");
  });

  // Approving max uint before a swap is how nearly every protocol integration
  // works, so the spender is what separates the legitimate case from the drain.
  it("allows an over-cap approval to a contract a protocol already uses", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "approve",
      inputTypes: ["address", "uint256"],
      args: [KNOWN_ROUTER, ethers.MaxUint256.toString()],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  // The complete drain path for a leaked key: grant an unbounded allowance,
  // then call transferFrom off platform where none of this code runs.
  it("refuses an over-cap approval to a spender nothing accounts for", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "approve",
      inputTypes: ["address", "uint256"],
      args: [UNKNOWN_SPENDER, ethers.MaxUint256.toString()],
    });

    expect(result.kind).toBe("denied");
  });

  // A userSpecifiedAddress contract resolves to whatever the caller passed, so
  // allowlisting it would trust exactly the input this control exists to check.
  it("does not trust a spender drawn from a user-specified contract", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "approve",
      inputTypes: ["address", "uint256"],
      args: [USER_SUPPLIED, ethers.MaxUint256.toString()],
    });

    expect(result.kind).toBe("denied");
  });

  it("leaves an approval under the ceiling alone whoever the spender is", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "approve",
      inputTypes: ["address", "uint256"],
      args: [UNKNOWN_SPENDER, units(BigInt(1), 6)],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("refuses a stablecoin transfer whose amount cannot be read", async () => {
    // Failing open here would hand back the unbounded move the cap exists to
    // stop.
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, { toString: () => "1" }],
    });

    expect(result.kind).toBe("denied");
  });

  it("ignores a function that is not an ERC-20 outflow", async () => {
    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "deposit",
      inputTypes: ["uint256"],
      args: [units(CAP_USD + BigInt(1), 6)],
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  it("ignores a same-named function with a different signature", async () => {
    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256", "bytes"],
      args: [RECIPIENT, units(CAP_USD + BigInt(1), 6), "0x"],
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  // Solidity aliases uint to uint256, and ethers canonicalises before it
  // computes the selector, so transfer(address,uint) encodes 0xa9059cbb -- a
  // real ERC-20 transfer. inputTypes reaches this module as the RAW declared
  // strings from a caller-supplied ABI, so a literal comparison against
  // "uint256" missed it and the call short-circuited to allowed without ever
  // loading the token. One word in an attacker-supplied ABI defeated the whole
  // ceiling. selectCalls asserts the token lookup actually ran, so this cannot
  // pass by accidentally allowing for some other reason.
  it.each([
    ["address", "uint"],
    ["address", "uint256"],
  ])("applies the ceiling to transfer declared as %j", async (...types) => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: types,
      args: [RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("denied");
    expect(state.selectCalls).toBe(1);
  });

  it("accepts a fully qualified overload key", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer(address,uint256)",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("denied");
  });
});

describe("checkStablecoinCalldataBatch", () => {
  const batchParams = {
    organizationId: "org_1",
    chainId: 1,
    context: "tempo",
  };

  function transferCall(amountUsd: bigint) {
    return {
      to: USDC_ADDRESS,
      data: erc20.encodeFunctionData("transfer", [
        RECIPIENT,
        units(amountUsd, 6),
      ]),
    };
  }

  // The bypass this entry point exists for. signTempoTx signs every call of a
  // batch payout as one transaction, so entries that each clear the per-call
  // ceiling still moved a multiple of it, and nothing bounded the entry count.
  it("sums a batch whose calls each sit under the per-call ceiling", async () => {
    state.tokenRows = [USDC];
    // Each entry clears the 100 USD per-call figure; together they pass the
    // batch total.
    const perEntry = CAP_USD - BigInt(10);
    const count = Number(BATCH_CAP_USD / perEntry) + 1;

    const result = await checkStablecoinCalldataBatch({
      ...batchParams,
      calls: Array.from({ length: count }, () => transferCall(perEntry)),
    });

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.error).toContain("per-transaction batch limit");
    }
  });

  // The case that made the per-call figure the wrong yardstick for a batch: a
  // payroll run of many small entries. Measured against 100 USD it capped
  // batch payouts at 2 USD a head, which removed the feature rather than
  // bounding it.
  it("admits a payroll-shaped batch of many small entries", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldataBatch({
      ...batchParams,
      calls: Array.from({ length: 50 }, () => transferCall(BigInt(20))),
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  // Summing alone is not enough either: without the per-call ceiling a single
  // large recipient hides under a generous batch total.
  it("refuses one over-cap entry even when the batch total is small", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldataBatch({
      ...batchParams,
      calls: [transferCall(CAP_USD + BigInt(1))],
    });

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.error).toContain("per-transaction limit");
    }
  });

  it("admits a batch whose total stays within the ceiling", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldataBatch({
      ...batchParams,
      calls: [transferCall(BigInt(10)), transferCall(BigInt(20))],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  // Every recognised token is pegged 1:1, so splitting a payout across two of
  // them moves exactly as much as sending it in one.
  it("sums across different stablecoins in the same transaction", async () => {
    state.tokenRows = [
      USDC,
      { ...USDC, tokenAddress: DAI_ADDRESS, symbol: "DAI", decimals: 18 },
    ];
    const half = BATCH_CAP_USD / BigInt(2) + BigInt(1);

    const result = await checkStablecoinCalldataBatch({
      ...batchParams,
      calls: [
        transferCall(half),
        {
          to: DAI_ADDRESS,
          data: erc20.encodeFunctionData("transfer", [
            RECIPIENT,
            units(half, 18),
          ]),
        },
      ],
    });

    expect(result.kind).toBe("denied");
  });

  it("ignores calls that are not recognised stablecoin outflows", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldataBatch({
      ...batchParams,
      calls: [
        { to: USDC_ADDRESS, data: "0xdeadbeef" },
        transferCall(BigInt(1)),
      ],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  // An approval is a standing grant, not a movement, so it is judged on its
  // own spender rather than folded into the transfer total.
  it("refuses a batch carrying an over-cap approval to an unknown spender", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldataBatch({
      ...batchParams,
      calls: [
        {
          to: USDC_ADDRESS,
          data: erc20.encodeFunctionData("approve", [
            UNKNOWN_SPENDER,
            ethers.MaxUint256.toString(),
          ]),
        },
      ],
    });

    expect(result.kind).toBe("denied");
  });
});

describe("checkStablecoinCalldata", () => {
  const calldataParams = {
    organizationId: "org_1",
    chainId: 1,
    to: USDC_ADDRESS,
    context: "test",
  };

  it("decodes and denies an over-cap transfer from raw calldata", async () => {
    // Tempo carries {to, data} with no ABI alongside, and moves TIP-20
    // stablecoins as its primary asset.
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transfer", [
        RECIPIENT,
        units(CAP_USD + BigInt(1), 6),
      ]),
    });

    expect(result.kind).toBe("denied");
  });

  it("allows an under-cap transfer from raw calldata", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transfer", [
        RECIPIENT,
        units(BigInt(5), 6),
      ]),
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("reads the amount from TIP-20 transferWithMemo, not from the memo", async () => {
    // Tempo's ordinary send is transferWithMemo(to, amount, memo): the amount
    // is the second argument, so a last-argument decode would read the memo and
    // wave the transfer through.
    state.tokenRows = [USDC];

    const over = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transferWithMemo", [
        RECIPIENT,
        units(CAP_USD + BigInt(1), 6),
        MEMO,
      ]),
    });
    expect(over.kind).toBe("denied");

    const under = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transferWithMemo", [
        RECIPIENT,
        units(BigInt(5), 6),
        MEMO,
      ]),
    });
    expect(under).toEqual({ kind: "allowed" });
  });

  it("ignores calldata for a function that is not an ERC-20 outflow", async () => {
    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("deposit", [units(CAP_USD, 6)]),
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  it("ignores calldata it cannot decode", async () => {
    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: "0xdeadbeef",
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });
});
