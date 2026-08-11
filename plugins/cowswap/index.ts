import type { IntegrationType } from "@/lib/types/integration";
import { getIntegration } from "@/plugins/registry";

const getQuoteAction = {
  slug: "get-quote",
  label: "Get Quote",
  description:
    "Get a price quote for a token swap from the CoW Swap orderbook API",
  category: "CoW Swap",
  stepFunction: "getQuoteStep",
  stepImportPath: "get-quote",
  configFields: [
    {
      key: "network",
      label: "Network",
      type: "chain-select" as const,
      chainTypeFilter: "evm",
      placeholder: "Select network",
      required: true,
    },
    {
      key: "sellToken",
      label: "Sell Token Address",
      type: "template-input" as const,
      placeholder: "0x... or {{NodeName.sellToken}}",
      example: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      required: true,
      isAddressField: true,
    },
    {
      key: "buyToken",
      label: "Buy Token Address",
      type: "template-input" as const,
      placeholder: "0x... or {{NodeName.buyToken}}",
      example: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      required: true,
      isAddressField: true,
    },
    {
      key: "from",
      label: "Trader Address",
      type: "template-input" as const,
      placeholder: "0x... wallet address",
      example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      required: true,
      isAddressField: true,
    },
    {
      key: "kind",
      label: "Order Kind",
      type: "template-input" as const,
      placeholder: "sell or buy",
      example: "sell",
      required: true,
    },
    {
      key: "amount",
      label: "Amount (in token base units)",
      type: "template-input" as const,
      placeholder: "1000000000000000000 (1 ETH)",
      example: "1000000000000000000",
      required: true,
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the request succeeded" },
    { field: "buyAmount", description: "Amount of buy token to receive" },
    { field: "sellAmount", description: "Amount of sell token to spend" },
    { field: "feeAmount", description: "Protocol fee amount" },
    { field: "quote", description: "Full quote object from the API" },
    { field: "error", description: "Error message if failed" },
  ],
};

const getOrderStatusAction = {
  slug: "get-order-status",
  label: "Get Order Status",
  description:
    "Check the status of a CoW Swap order by its order UID from the orderbook API",
  category: "CoW Swap",
  stepFunction: "getOrderStatusStep",
  stepImportPath: "get-order-status",
  configFields: [
    {
      key: "network",
      label: "Network",
      type: "chain-select" as const,
      chainTypeFilter: "evm",
      placeholder: "Select network",
      required: true,
    },
    {
      key: "orderUid",
      label: "Order UID",
      type: "template-input" as const,
      placeholder: "0x... 56-byte order identifier",
      example: "0xabc123...",
      required: true,
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the request succeeded" },
    { field: "status", description: "Order status (open, filled, cancelled, expired)" },
    { field: "filledAmount", description: "Amount filled so far" },
    { field: "executedBuyAmount", description: "Buy token amount actually received" },
    { field: "executedSellAmount", description: "Sell token amount actually spent" },
    { field: "order", description: "Full order object from the API" },
    { field: "error", description: "Error message if failed" },
  ],
};

const createOrderAction = {
  slug: "create-order",
  label: "Create Order",
  description:
    "Submit a pre-built signed order to the CoW Swap orderbook. The order must be fully constructed and signed externally before submission.",
  category: "CoW Swap",
  stepFunction: "createOrderStep",
  stepImportPath: "create-order",
  configFields: [
    {
      key: "network",
      label: "Network",
      type: "chain-select" as const,
      chainTypeFilter: "evm",
      placeholder: "Select network",
      required: true,
    },
    {
      key: "orderPayload",
      label: "Signed Order Payload (JSON)",
      type: "template-input" as const,
      placeholder: '{"sellToken":"0x...","buyToken":"0x...",...}',
      required: true,
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the request succeeded" },
    { field: "orderUid", description: "The UID of the created order" },
    { field: "error", description: "Error message if failed" },
  ],
};

const cancelOrderAction = {
  slug: "cancel-order",
  label: "Cancel Order",
  description:
    "Cancel a pending CoW Swap order via the orderbook API before it is filled",
  category: "CoW Swap",
  stepFunction: "cancelOrderStep",
  stepImportPath: "cancel-order",
  configFields: [
    {
      key: "network",
      label: "Network",
      type: "chain-select" as const,
      chainTypeFilter: "evm",
      placeholder: "Select network",
      required: true,
    },
    {
      key: "orderUid",
      label: "Order UID",
      type: "template-input" as const,
      placeholder: "0x... 56-byte order identifier",
      example: "0xabc123...",
      required: true,
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the request succeeded" },
    { field: "error", description: "Error message if failed" },
  ],
};

const getAccountOrdersAction = {
  slug: "get-account-orders",
  label: "Get Account Orders",
  description:
    "List all orders placed by a wallet address from the CoW Swap orderbook API",
  category: "CoW Swap",
  stepFunction: "getAccountOrdersStep",
  stepImportPath: "get-account-orders",
  configFields: [
    {
      key: "network",
      label: "Network",
      type: "chain-select" as const,
      chainTypeFilter: "evm",
      placeholder: "Select network",
      required: true,
    },
    {
      key: "ownerAddress",
      label: "Owner Address",
      type: "template-input" as const,
      placeholder: "0x... wallet address",
      example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      required: true,
      isAddressField: true,
    },
    {
      key: "limit",
      label: "Limit",
      type: "template-input" as const,
      placeholder: "50",
      example: "50",
      required: false,
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the request succeeded" },
    { field: "orders", description: "Array of orders for the account" },
    { field: "count", description: "Number of orders returned" },
    { field: "error", description: "Error message if failed" },
  ],
};

const getTradesAction = {
  slug: "get-trades",
  label: "Get Trades",
  description:
    "Get executed trades for a wallet address from the CoW Swap orderbook API",
  category: "CoW Swap",
  stepFunction: "getTradesStep",
  stepImportPath: "get-trades",
  configFields: [
    {
      key: "network",
      label: "Network",
      type: "chain-select" as const,
      chainTypeFilter: "evm",
      placeholder: "Select network",
      required: true,
    },
    {
      key: "ownerAddress",
      label: "Owner Address",
      type: "template-input" as const,
      placeholder: "0x... wallet address",
      example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      required: true,
      isAddressField: true,
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the request succeeded" },
    { field: "trades", description: "Array of executed trades for the account" },
    { field: "count", description: "Number of trades returned" },
    { field: "error", description: "Error message if failed" },
  ],
};

// Inject HTTP API actions into the protocol-registered "cowswap" integration
// so both on-chain protocol actions and off-chain API actions appear under one entry.
// CoW Swap does not require credentials -- the orderbook API is public.
const cowswapProtocol = getIntegration("cowswap" as IntegrationType);
if (!cowswapProtocol) {
  throw new Error(
    '[cowswap plugin] "cowswap" integration not found in registry. Ensure keeperhub/protocols is imported before keeperhub/plugins/cowswap.'
  );
}

cowswapProtocol.actions.push(getQuoteAction);
cowswapProtocol.actions.push(getOrderStatusAction);
cowswapProtocol.actions.push(createOrderAction);
cowswapProtocol.actions.push(cancelOrderAction);
cowswapProtocol.actions.push(getAccountOrdersAction);
cowswapProtocol.actions.push(getTradesAction);

export default cowswapProtocol;
