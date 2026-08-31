import {
  queryErrorOutput,
  querySuccessOutput,
} from "@/plugins/field-fragments";
import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { PythIcon } from "./icon";

const pythPlugin: IntegrationPlugin = {
  type: "pyth" as any,
  egress: "fixed-host",
  label: "Pyth Network",
  description:
    "Real-time oracle price feeds, confidence intervals, and binary update data (VAA) from Pyth Network for multi-chain Web3 workflows.",

  icon: PythIcon,

  requiresCredentials: false,

  formFields: [
    {
      id: "info",
      label: "Pyth Network Hermes API",
      type: "text",
      placeholder: "No configuration needed",
      configKey: "info",
      helpText:
        "The Pyth Network Hermes REST API is public and requires no authentication. Actions call https://hermes.pyth.network directly.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testPyth } = await import("./test");
      return testPyth;
    },
  },

  actions: [
    {
      slug: "get-price",
      label: "Get Latest Price",
      description:
        "Get real-time price, confidence interval, EMA price, and formatted decimal values for Pyth price feeds (e.g. ETH/USD, BTC/USD, SOL/USD, or raw Feed ID).",
      category: "Pyth Network",
      stepFunction: "getPriceStep",
      stepImportPath: "get-price",
      outputFields: [
        querySuccessOutput(),
        {
          field: "price",
          description: "Formatted price as float (e.g. 3450.25)",
        },
        {
          field: "priceString",
          description: "Price formatted as string",
        },
        {
          field: "confidence",
          description: "Confidence interval float",
        },
        {
          field: "expo",
          description: "Price exponent (e.g. -8)",
        },
        {
          field: "publishTime",
          description: "Unix timestamp (seconds) when the price was published",
        },
        {
          field: "feedId",
          description: "Pyth price feed hex ID (0x-prefixed)",
        },
        {
          field: "emaPrice",
          description: "Exponential moving average (EMA) price float",
        },
        {
          field: "emaConfidence",
          description: "EMA confidence float",
        },
        queryErrorOutput(),
      ],
      configFields: [
        {
          key: "feedId",
          label: "Price Feed ID or Symbol",
          type: "template-input",
          placeholder: "ETH/USD, BTC/USD, SOL/USD or 0x...",
          example: "ETH/USD",
          required: true,
          helpTip:
            "Enter a popular symbol like ETH/USD, BTC/USD, SOL/USD or a full 64-character Pyth price feed hex ID.",
        },
      ],
    },
    {
      slug: "get-update-data",
      label: "Get Price Update Data (VAA)",
      description:
        "Get binary VAA price update bytes to pass into on-chain Pyth contract updatePriceFeeds(bytes[]) calls before executing a transaction.",
      category: "Pyth Network",
      stepFunction: "getUpdateDataStep",
      stepImportPath: "get-update-data",
      outputFields: [
        querySuccessOutput(),
        {
          field: "updateData",
          description: "Array of hex or base64 price update data strings for on-chain submission",
        },
        {
          field: "encoding",
          description: "Encoding format (hex or base64)",
        },
        {
          field: "feedIds",
          description: "Array of feed IDs included in the update payload",
        },
        {
          field: "updateDataCount",
          description: "Total number of update payloads returned",
        },
        queryErrorOutput(),
      ],
      configFields: [
        {
          key: "feedIds",
          label: "Price Feed IDs / Symbols",
          type: "template-input",
          placeholder: "ETH/USD, BTC/USD or comma-separated 0x... IDs",
          example: "ETH/USD, BTC/USD",
          required: true,
          helpTip:
            "Comma-separated list of symbols (e.g. ETH/USD, BTC/USD) or Pyth feed IDs to include in the on-chain update payload.",
        },
        {
          key: "encoding",
          label: "Encoding",
          type: "select",
          options: [
            { value: "hex", label: "Hexadecimal (0x-prefixed, EVM)" },
            { value: "base64", label: "Base64 (Solana / CosmWasm)" },
          ],
          defaultValue: "hex",
          helpTip: "Select hex for EVM contracts or base64 for Solana/CosmWasm.",
        },
      ],
    },
    {
      slug: "search-price-feeds",
      label: "Search Price Feeds",
      description:
        "Search for Pyth price feed metadata and feed IDs by asset symbol or keyword (e.g. ETH, BTC, SOL, AAPL, EUR).",
      category: "Pyth Network",
      stepFunction: "searchPriceFeedsStep",
      stepImportPath: "search-price-feeds",
      outputFields: [
        querySuccessOutput(),
        {
          field: "feeds",
          description: "Array of Pyth feed metadata objects [{ id, symbol, assetType, base, quote }]",
        },
        {
          field: "count",
          description: "Total number of matching price feeds returned",
        },
        queryErrorOutput(),
      ],
      configFields: [
        {
          key: "query",
          label: "Search Query",
          type: "template-input",
          placeholder: "ETH, BTC, SOL, AAPL, EUR...",
          example: "ETH",
          helpTip: "Asset symbol or keyword to search in Pyth's price feed catalog.",
        },
        {
          key: "assetType",
          label: "Asset Type",
          type: "select",
          options: [
            { value: "", label: "All Asset Types" },
            { value: "crypto", label: "Crypto" },
            { value: "equity", label: "Equity" },
            { value: "fx", label: "FX / Currencies" },
            { value: "metal", label: "Metals" },
            { value: "rates", label: "Interest Rates" },
          ],
          defaultValue: "",
          helpTip: "Filter search results by asset class.",
        },
      ],
    },
  ],
};

registerIntegration(pythPlugin);

export default pythPlugin;
