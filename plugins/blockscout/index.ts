import type { ActionConfigField, IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { SUPPORTED_BLOCKSCOUT_CHAIN_IDS } from "./chains";
import { BlockscoutIcon } from "./icon";

// Chain picker shared by every action. Maps to a hosted Blockscout instance so
// a workflow can query any supported chain with no connection setup. Defaults
// to Ethereum mainnet; for a chain not listed, attach a Blockscout connection
// with its instance URL. Factories return fresh objects so no field instance
// is aliased across actions.
const networkField = (): ActionConfigField => ({
  key: "network",
  label: "Chain",
  type: "chain-select",
  chainTypeFilter: "evm",
  allowedChainIds: [...SUPPORTED_BLOCKSCOUT_CHAIN_IDS],
  defaultValue: "1",
  helpTip:
    "Which chain's Blockscout explorer to query. Defaults to Ethereum mainnet. For a chain not listed here, add a Blockscout connection with its instance URL.",
});

// Address input shared verbatim by the address-scoped actions.
const addressField = (): ActionConfigField => ({
  key: "address",
  label: "Address",
  type: "template-input",
  placeholder: "0x... or {{NodeName.address}}",
  example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  required: true,
});

const blockscoutPlugin: IntegrationPlugin = {
  type: "blockscout",
  egress: "user-destination",
  label: "Blockscout",
  description: "Query the Blockscout block explorer REST API",

  icon: BlockscoutIcon,

  // Works against the public Ethereum mainnet instance without credentials.
  // Add an integration to point at a different instance or supply an API key.
  requiresCredentials: false,

  formFields: [
    {
      id: "apiUrl",
      label: "Blockscout Instance URL",
      type: "url",
      placeholder: "https://eth.blockscout.com",
      configKey: "apiUrl",
      envVar: "BLOCKSCOUT_API_URL",
      helpText: "Base URL of the Blockscout instance to query. ",
      helpLink: {
        text: "Browse instances",
        url: "https://www.blockscout.com/chains-and-projects",
      },
    },
    {
      id: "apiKey",
      label: "API Key (optional)",
      type: "password",
      placeholder: "Optional - for higher rate limits",
      configKey: "apiKey",
      envVar: "BLOCKSCOUT_API_KEY",
      helpText: "Optional API key for higher rate limits on hosted instances.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testBlockscout } = await import("./test");
      return testBlockscout;
    },
  },

  actions: [
    {
      slug: "get-address-balance",
      label: "Get Address Balance",
      description:
        "Look up the native coin balance and metadata for an address",
      category: "Blockscout",
      stepFunction: "getAddressBalanceStep",
      stepImportPath: "get-address-balance",
      outputFields: [
        { field: "success", description: "Whether the lookup succeeded" },
        { field: "address", description: "The resolved address" },
        { field: "balance", description: "Native coin balance in wei" },
        { field: "isContract", description: "Whether the address is a contract" },
        { field: "ensName", description: "Associated ENS name, if any" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        networkField(),
        addressField(),
      ],
    },
    {
      slug: "get-address-info",
      label: "Get Address Info",
      description:
        "Fetch the full address summary including balance, reputation, and verification flags",
      category: "Blockscout",
      stepFunction: "getAddressInfoStep",
      stepImportPath: "get-address-info",
      outputFields: [
        { field: "success", description: "Whether the lookup succeeded" },
        { field: "address", description: "The resolved address" },
        { field: "coinBalance", description: "Native coin balance in wei" },
        { field: "exchangeRate", description: "Native coin price in USD, if available" },
        { field: "isScam", description: "Whether Blockscout flags the address as a scam" },
        { field: "isVerified", description: "Whether the contract source is verified" },
        { field: "isContract", description: "Whether the address is a contract" },
        { field: "reputation", description: "Blockscout reputation flag (e.g. ok)" },
        { field: "ensName", description: "Associated ENS name, if any" },
        { field: "proxyType", description: "Proxy type, if the address is a proxy (e.g. eip7702)" },
        { field: "publicTags", description: "Public tags applied to the address" },
        { field: "hasTokenTransfers", description: "Whether the address has token transfers" },
        { field: "hasTokens", description: "Whether the address holds tokens" },
        { field: "hasLogs", description: "Whether the address has event logs" },
        { field: "blockNumberBalanceUpdatedAt", description: "Block at which the balance was last updated" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        networkField(),
        addressField(),
      ],
    },
    {
      slug: "get-address-counters",
      label: "Get Address Counters",
      description:
        "Fetch activity counters for an address (transactions, token transfers, gas usage)",
      category: "Blockscout",
      stepFunction: "getAddressCountersStep",
      stepImportPath: "get-address-counters",
      outputFields: [
        { field: "success", description: "Whether the lookup succeeded" },
        { field: "transactionsCount", description: "Total number of transactions" },
        { field: "tokenTransfersCount", description: "Total number of token transfers" },
        { field: "gasUsageCount", description: "Total gas used across transactions" },
        { field: "validationsCount", description: "Number of blocks validated by the address" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        networkField(),
        addressField(),
      ],
    },
    {
      slug: "get-transaction",
      label: "Get Transaction",
      description: "Fetch details for a transaction by hash",
      category: "Blockscout",
      stepFunction: "getTransactionStep",
      stepImportPath: "get-transaction",
      outputFields: [
        { field: "success", description: "Whether the lookup succeeded" },
        { field: "hash", description: "Transaction hash" },
        { field: "status", description: "Transaction status (ok / error)" },
        { field: "value", description: "Value transferred in wei" },
        { field: "from", description: "Sender address" },
        { field: "to", description: "Recipient address" },
        { field: "blockNumber", description: "Block number the tx was mined in" },
        { field: "fee", description: "Transaction fee in wei" },
        { field: "method", description: "Decoded method name, if any" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        networkField(),
        {
          key: "txHash",
          label: "Transaction Hash",
          type: "template-input",
          placeholder: "0x... or {{NodeName.hash}}",
          example:
            "0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b",
          required: true,
        },
      ],
    },
    {
      slug: "get-token-info",
      label: "Get Token Info",
      description: "Fetch metadata for an ERC-20/721/1155 token contract",
      category: "Blockscout",
      stepFunction: "getTokenInfoStep",
      stepImportPath: "get-token-info",
      outputFields: [
        { field: "success", description: "Whether the lookup succeeded" },
        { field: "address", description: "Token contract address" },
        { field: "name", description: "Token name" },
        { field: "symbol", description: "Token symbol" },
        { field: "decimals", description: "Token decimals" },
        { field: "totalSupply", description: "Total supply in base units" },
        { field: "type", description: "Token type (ERC-20, ERC-721, ERC-1155)" },
        { field: "holders", description: "Number of holders" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        networkField(),
        {
          key: "tokenAddress",
          label: "Token Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
          required: true,
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(blockscoutPlugin);

export default blockscoutPlugin;
