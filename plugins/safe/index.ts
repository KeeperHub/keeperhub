import type { IntegrationType } from "@/lib/types/integration";
import { getIntegration } from "@/plugins/registry";

const getPendingTransactionsAction = {
  slug: "get-pending-transactions",
  label: "Get Pending Transactions",
  description:
    "Fetch pending multisig transactions from a Safe that have not been executed yet. Optionally filter for transactions a specific signer has not confirmed.",
  category: "Safe",
  stepFunction: "getPendingTransactionsStep",
  stepImportPath: "get-pending-transactions",
  requiresCredentials: true,
  credentialIntegrationType: "safe" as string,
  outputFields: [
    {
      field: "success",
      description: "Whether the request succeeded",
    },
    {
      field: "transactions",
      description:
        "Array of pending transactions with safeTxHash, to, value, data, operation, nonce, confirmations, confirmationsRequired, dataDecoded, and submissionDate",
    },
    {
      field: "count",
      description: "Number of pending transactions returned",
    },
    { field: "error", description: "Error message if failed" },
  ],
  configFields: [
    {
      key: "safeAddress",
      label: "Safe Address",
      type: "template-input" as const,
      placeholder: "0x... or {{NodeName.address}}",
      example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      required: true,
    },
    {
      key: "network",
      label: "Network",
      type: "chain-select" as const,
      chainTypeFilter: "evm",
      placeholder: "Select network",
      required: true,
    },
    {
      key: "signerAddress",
      label: "Signer Address",
      type: "template-input" as const,
      placeholder:
        "0x... filter for txs this address has not signed (optional)",
      example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      required: false,
    },
  ],
};

// Inject get-pending-transactions into the protocol-registered "safe" integration
// so both on-chain reads and off-chain API actions appear under one "Safe" entry.
// Also attach credential fields so the connection management UI can create Safe API keys.
const safeProtocol = getIntegration("safe" as IntegrationType);
if (!safeProtocol) {
  throw new Error(
    '[safe plugin] "safe" integration not found in registry. Ensure keeperhub/protocols is imported before keeperhub/plugins/safe.'
  );
}

safeProtocol.actions.push(getPendingTransactionsAction);
safeProtocol.requiresCredentials = true;
safeProtocol.formFields = [
  {
    id: "apiKey",
    label: "API Key",
    type: "password",
    placeholder: "Your Safe Transaction Service API key",
    configKey: "apiKey",
    envVar: "apiKey",
    helpText:
      "JWT API key from the Safe developer portal. Required for accessing the Transaction Service.",
    helpLink: {
      text: "Get an API key",
      url: "https://developer.safe.global/",
    },
  },
];
safeProtocol.testConfig = {
  getTestFunction: async () => {
    const { testSafe } = await import("./test");
    return testSafe;
  },
};

// Export the enriched protocol integration for use by other modules.
// No separate registerIntegration call -- the protocol-registered "safe"
// integration already has everything (protocol actions + injected action +
// credential config).
export default safeProtocol;
