import { describe, expect, it } from "vitest";
import {
  type AbiDrivenContract,
  camelToKebab,
  camelToTitle,
  deriveActionsFromAbi,
} from "@/lib/abi/protocol-derive";

describe("camelToKebab", () => {
  it("converts camelCase to kebab-case", () => {
    expect(camelToKebab("balanceOf")).toBe("balance-of");
    expect(camelToKebab("getFee")).toBe("get-fee");
    expect(camelToKebab("ccipSend")).toBe("ccip-send");
    expect(camelToKebab("deposit")).toBe("deposit");
  });

  it("handles consecutive uppercase", () => {
    expect(camelToKebab("getETHBalance")).toBe("get-eth-balance");
    expect(camelToKebab("parseUSDValue")).toBe("parse-usd-value");
  });

  it("handles single-word lowercase", () => {
    expect(camelToKebab("withdraw")).toBe("withdraw");
  });
});

describe("camelToTitle", () => {
  it("converts camelCase to title case", () => {
    expect(camelToTitle("balanceOf")).toBe("Balance Of");
    expect(camelToTitle("getFee")).toBe("Get Fee");
    expect(camelToTitle("deposit")).toBe("Deposit");
  });

  it("handles consecutive uppercase", () => {
    expect(camelToTitle("getETHBalance")).toBe("Get ETH Balance");
  });
});

describe("deriveActionsFromAbi", () => {
  const makeContract = (
    abi: unknown[],
    overrides?: AbiDrivenContract["overrides"]
  ): AbiDrivenContract => ({
    label: "Test Contract",
    abi: JSON.stringify(abi),
    addresses: { "1": "0x0000000000000000000000000000000000000001" },
    overrides,
  });

  it("derives correct action count from ABI", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "deposit",
        stateMutability: "payable",
        inputs: [],
        outputs: [],
      },
      {
        type: "function",
        name: "withdraw",
        stateMutability: "nonpayable",
        inputs: [{ name: "amount", type: "uint256" }],
        outputs: [],
      },
      { type: "event", name: "Transfer", inputs: [] },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions).toHaveLength(2);
  });

  it("determines read vs write from stateMutability", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
      {
        type: "function",
        name: "totalSupply",
        stateMutability: "pure",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
      },
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].type).toBe("read");
    expect(actions[1].type).toBe("read");
    expect(actions[2].type).toBe("write");
  });

  it("sets payable flag from stateMutability", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "deposit",
        stateMutability: "payable",
        inputs: [],
        outputs: [],
      },
      {
        type: "function",
        name: "withdraw",
        stateMutability: "nonpayable",
        inputs: [{ name: "amount", type: "uint256" }],
        outputs: [],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].payable).toBe(true);
    expect(actions[1].payable).toBeUndefined();
  });

  it("generates slug and label from function name", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].slug).toBe("balance-of");
    expect(actions[0].label).toBe("Balance Of");
  });

  it("applies slug and label overrides", () => {
    const contract = makeContract(
      [
        {
          type: "function",
          name: "deposit",
          stateMutability: "payable",
          inputs: [],
          outputs: [],
        },
      ],
      {
        deposit: {
          slug: "wrap",
          label: "Wrap ETH",
          description: "Wrap native ETH into WETH",
        },
      }
    );
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].slug).toBe("wrap");
    expect(actions[0].label).toBe("Wrap ETH");
    expect(actions[0].description).toBe("Wrap native ETH into WETH");
  });

  it("generates input labels from param names", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].inputs[0].label).toBe("To");
    expect(actions[0].inputs[1].label).toBe("Amount");
  });

  it("applies input overrides for label, default, helpTip", () => {
    const contract = makeContract(
      [
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [{ name: "wad", type: "uint256" }],
          outputs: [],
        },
      ],
      {
        withdraw: {
          inputs: {
            wad: {
              label: "Amount (wei)",
              helpTip: "Amount of WETH to unwrap",
              default: "0",
            },
          },
        },
      }
    );
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].inputs[0].label).toBe("Amount (wei)");
    expect(actions[0].inputs[0].helpTip).toBe("Amount of WETH to unwrap");
    expect(actions[0].inputs[0].default).toBe("0");
  });

  it("handles unnamed ABI inputs with generated names", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].inputs[0].name).toBe("arg0");
  });

  it("renames unnamed inputs via override", () => {
    const contract = makeContract(
      [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      {
        balanceOf: {
          inputs: {
            arg0: { name: "account", label: "Wallet Address" },
          },
        },
      }
    );
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].inputs[0].name).toBe("account");
    expect(actions[0].inputs[0].label).toBe("Wallet Address");
  });

  it("handles unnamed ABI outputs with generated names", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].outputs?.[0].name).toBe("result");
  });

  it("uses result0/result1 for multiple unnamed outputs", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "getData",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { name: "", type: "uint256" },
          { name: "", type: "address" },
        ],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].outputs?.[0].name).toBe("result0");
    expect(actions[0].outputs?.[1].name).toBe("result1");
  });

  it("renames outputs via override", () => {
    const contract = makeContract(
      [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      {
        balanceOf: {
          outputs: {
            result: {
              name: "balance",
              label: "WETH Balance (wei)",
              decimals: 18,
            },
          },
        },
      }
    );
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].outputs?.[0].name).toBe("balance");
    expect(actions[0].outputs?.[0].label).toBe("WETH Balance (wei)");
    expect(actions[0].outputs?.[0].decimals).toBe(18);
  });

  it("skips hidden inputs", () => {
    const contract = makeContract(
      [
        {
          type: "function",
          name: "send",
          stateMutability: "nonpayable",
          inputs: [
            { name: "to", type: "address" },
            { name: "data", type: "bytes" },
          ],
          outputs: [],
        },
      ],
      {
        send: {
          inputs: {
            data: { hidden: true },
          },
        },
      }
    );
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].inputs).toHaveLength(1);
    expect(actions[0].inputs[0].name).toBe("to");
  });

  it("generates outputs for write functions when ABI declares them", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].outputs).toHaveLength(1);
  });

  it("sets contract key on all derived actions", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "deposit",
        stateMutability: "payable",
        inputs: [],
        outputs: [],
      },
    ]);
    const actions = deriveActionsFromAbi("myContract", contract);
    expect(actions[0].contract).toBe("myContract");
  });

  it("preserves Solidity types on inputs and outputs", () => {
    const contract = makeContract([
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
      },
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "balance", type: "uint256" }],
      },
    ]);
    const actions = deriveActionsFromAbi("test", contract);
    expect(actions[0].inputs[0].type).toBe("address");
    expect(actions[0].inputs[1].type).toBe("uint256");
    expect(actions[1].outputs?.[0].type).toBe("uint256");
  });
});
