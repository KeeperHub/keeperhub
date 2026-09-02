import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { EvmChainIcon } from "./icon";

const evmChainPlugin: IntegrationPlugin = {
  type: "evm-chain",
  // This plugin fetches a user-supplied JSON-RPC endpoint.
  egress: "user-destination",
  label: "EVM Chain",
  description:
    "Read-only EVM chain diagnostics: chain id, latest block, native and ERC-20 balances, and gas price on any EVM-compatible chain via a public JSON-RPC URL. No wallet or credentials required - complementary to the Web3 plugin (zero-credential preview/diagnostic queries against any public endpoint).",

  icon: EvmChainIcon,

  formFields: [
    {
      id: "rpcUrl",
      label: "JSON-RPC URL",
      type: "url",
      placeholder: "https://sepolia.base.org",
      configKey: "EVM_CHAIN_RPC_URL",
      envVar: "EVM_CHAIN_RPC_URL",
      helpText: "Any EVM JSON-RPC endpoint (Alchemy, Infura, CDP, public gateway...).",
      helpLink: {
        text: "Base docs - Network RPC endpoints",
        url: "https://docs.base.org/guides/rpc-endpoints/",
      },
    },
    {
      id: "chainName",
      label: "Chain name (display only)",
      type: "text",
      placeholder: "Base Sepolia",
      configKey: "EVM_CHAIN_NAME",
      envVar: "EVM_CHAIN_NAME",
      helpText: "Optional human-readable label shown in the UI.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testEvmChain } = await import("./test");
      return testEvmChain;
    },
  },

  actions: [
    {
      slug: "chain-info",
      label: "Chain info",
      description: "Return the chain id (hex + decimal) and the latest block number.",
      category: "EVM Chain",
      stepFunction: "chainInfoStep",
      stepImportPath: "chain-info",
      configFields: [],
      outputFields: [
        { field: "success", description: "Whether the query succeeded" },
        { field: "chainId", description: "Chain id as hex string" },
        { field: "chainIdDecimal", description: "Chain id as decimal number" },
        { field: "latestBlock", description: "Latest mined block number" },
        { field: "error", description: "Error message if failed" },
      ],
    },
    {
      slug: "eth-balance",
      label: "Native token balance",
      description: "Return the native token balance of an address in wei and native units.",
      category: "EVM Chain",
      stepFunction: "ethBalanceStep",
      stepImportPath: "eth-balance",
      configFields: [
        {
          key: "address",
          label: "Address",
          type: "template-input",
          placeholder: "0x... or use {{NodeName.field}}",
          example: "0x2f13...8d15",
          required: true,
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the query succeeded" },
        { field: "address", description: "Queried address" },
        { field: "balanceWei", description: "Balance in wei" },
        { field: "balanceNative", description: "Balance in native units (18 decimals)" },
        { field: "error", description: "Error message if failed" },
      ],
    },
    {
      slug: "erc20-balance",
      label: "ERC-20 balance",
      description: "Return the balance of an ERC-20 token held by an address.",
      category: "EVM Chain",
      stepFunction: "erc20BalanceStep",
      stepImportPath: "erc20-balance",
      configFields: [
        {
          key: "token",
          label: "Token address",
          type: "template-input",
          placeholder: "0x...",
          example: "0x036C...CF7e",
          required: true,
        },
        {
          key: "holder",
          label: "Holder address",
          type: "template-input",
          placeholder: "0x... or use {{NodeName.field}}",
          example: "0x2f13...8d15",
          required: true,
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the query succeeded" },
        { field: "token", description: "Token address" },
        { field: "holder", description: "Holder address" },
        { field: "balance", description: "Raw token balance (string, token decimals)" },
        { field: "error", description: "Error message if failed" },
      ],
    },
    {
      slug: "gas-price",
      label: "Gas price",
      description: "Return the suggested gas price in wei.",
      category: "EVM Chain",
      stepFunction: "gasPriceStep",
      stepImportPath: "gas-price",
      configFields: [],
      outputFields: [
        { field: "success", description: "Whether the query succeeded" },
        { field: "gasPriceWei", description: "Suggested gas price in wei" },
        { field: "error", description: "Error message if failed" },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(evmChainPlugin);

export default evmChainPlugin;
