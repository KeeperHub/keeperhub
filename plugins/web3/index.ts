import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry";
import { Web3Icon } from "./icon";

const web3Plugin: IntegrationPlugin = {
  type: "web3",
  label: "Web3",
  description: "Interact with blockchain networks using your Para wallet",

  icon: Web3Icon,

  // Web3 uses Para wallet - one wallet per user
  singleConnection: true,

  // Read-only actions (check balance, read contract) don't require a wallet
  // Write actions will check for wallet at execution time
  requiresCredentials: false,

  // No form fields - wallet creation is handled by the custom form handler
  formFields: [],

  testConfig: {
    getTestFunction: async () => {
      const { testWeb3 } = await import("./test");
      return testWeb3;
    },
  },

  actions: [
    {
      slug: "check-balance",
      label: "Get Native Token Balance",
      description: "Get native token balance (ETH, MATIC, etc.) of any address",
      category: "Web3",
      stepFunction: "checkBalanceStep",
      stepImportPath: "check-balance",
      outputFields: [
        {
          field: "success",
          description: "Whether the balance check succeeded",
        },
        {
          field: "balance",
          description: "Balance in ETH (human-readable)",
        },
        {
          field: "balanceWei",
          description: "Balance in Wei (smallest unit)",
        },
        {
          field: "address",
          description: "The address that was checked",
        },
        {
          field: "error",
          description: "Error message if the check failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "address",
          label: "Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          required: true,
        },
      ],
    },
    {
      slug: "check-token-balance",
      label: "Get ERC20 Token Balance",
      description: "Get ERC20 token balance of any address",
      category: "Web3",
      stepFunction: "checkTokenBalanceStep",
      stepImportPath: "check-token-balance",
      outputFields: [
        {
          field: "success",
          description: "Whether the balance check succeeded",
        },
        {
          field: "balance",
          description: "Token balance object",
        },
        {
          field: "balance.balance",
          description: "The token balance amount (human-readable string)",
        },
        {
          field: "balance.balanceRaw",
          description: "The token balance in raw units (string)",
        },
        {
          field: "balance.symbol",
          description: "The token symbol (e.g., USDC)",
        },
        {
          field: "balance.decimals",
          description: "The token decimals",
        },
        {
          field: "balance.name",
          description: "The token name",
        },
        {
          field: "balance.tokenAddress",
          description: "The token contract address",
        },
        {
          field: "address",
          description: "The wallet address that was checked",
        },
        {
          field: "addressLink",
          description: "Explorer link to the wallet address",
        },
        {
          field: "error",
          description: "Error message if the check failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "address",
          label: "Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          required: true,
        },
        {
          key: "tokenConfig",
          label: "Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
      ],
    },
    {
      slug: "transfer-funds",
      label: "Transfer Native Token",
      description:
        "Transfer native tokens (ETH, MATIC, etc.) from your wallet to a recipient address",
      category: "Web3",
      requiresCredentials: true,
      stepFunction: "transferFundsStep",
      stepImportPath: "transfer-funds",
      outputFields: [
        {
          field: "success",
          description: "Whether the transfer succeeded",
        },
        {
          field: "transactionHash",
          description: "The transaction hash of the successful transfer",
        },
        {
          field: "error",
          description: "Error message if the transfer failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "amount",
          label: "Amount (ETH)",
          type: "template-input",
          placeholder: "0.1 or {{NodeName.amount}}",
          example: "0.1",
          required: true,
        },
        {
          key: "recipientAddress",
          label: "Recipient Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "transfer-funds",
            },
          ],
        },
      ],
    },
    {
      slug: "transfer-token",
      label: "Transfer ERC20 Token",
      description: "Transfer ERC20 tokens on your desired EVM chain",
      category: "Web3",
      requiresCredentials: true,
      stepFunction: "transferTokenStep",
      stepImportPath: "transfer-token",
      outputFields: [
        {
          field: "success",
          description: "Whether the transfer succeeded",
        },
        {
          field: "transactionHash",
          description: "The transaction hash of the successful transfer",
        },
        {
          field: "transactionLink",
          description: "Explorer link to view the transaction",
        },
        {
          field: "amount",
          description: "The amount transferred (human-readable)",
        },
        {
          field: "symbol",
          description: "The token symbol (e.g., USDC)",
        },
        {
          field: "recipient",
          description: "The recipient address",
        },
        {
          field: "error",
          description: "Error message if the transfer failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "tokenConfig",
          label: "Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
        {
          key: "amount",
          label: "Amount",
          type: "template-input",
          placeholder: "100.50 or {{NodeName.amount}}",
          example: "100.50",
          required: true,
        },
        {
          key: "recipientAddress",
          label: "Recipient Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "transfer-token",
            },
          ],
        },
      ],
    },
    {
      slug: "read-contract",
      label: "Read Contract",
      description: "Read data from a smart contract (view/pure functions)",
      category: "Web3",
      stepFunction: "readContractStep",
      stepImportPath: "read-contract",
      outputFields: [
        {
          field: "success",
          description: "Whether the contract call succeeded",
        },
        {
          field: "result",
          description:
            "The contract function return value (structured based on ABI outputs)",
        },
        {
          field: "error",
          description: "Error message if the call failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "contractAddress",
          label: "Contract Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.contractAddress}}",
          example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          required: true,
        },
        {
          key: "abi",
          label: "Contract ABI",
          type: "abi-with-auto-fetch",
          contractAddressField: "contractAddress",
          contractInteractionType: "read",
          networkField: "network",
          rows: 6,
          required: true,
        },
        {
          key: "abiFunction",
          label: "Function",
          type: "abi-function-select",
          abiField: "abi",
          placeholder: "Select a function",
          required: true,
        },
        {
          key: "functionArgs",
          label: "Function Arguments",
          type: "abi-function-args",
          abiField: "abi",
          abiFunctionField: "abiFunction",
        },
      ],
    },
    {
      slug: "get-transaction",
      label: "Get Transaction",
      description:
        "Fetch full transaction details by hash, including sender, recipient, value, and calldata",
      category: "Web3",
      stepFunction: "getTransactionStep",
      stepImportPath: "get-transaction",
      outputFields: [
        {
          field: "success",
          description: "Whether the transaction was found",
        },
        {
          field: "hash",
          description: "The transaction hash",
        },
        {
          field: "from",
          description: "Sender address",
        },
        {
          field: "to",
          description: "Recipient address (null for contract creation)",
        },
        {
          field: "value",
          description: "Value sent in ETH (human-readable)",
        },
        {
          field: "input",
          description: "Transaction input data (calldata)",
        },
        {
          field: "nonce",
          description: "Transaction nonce",
        },
        {
          field: "gasLimit",
          description: "Gas limit for the transaction",
        },
        {
          field: "blockNumber",
          description: "Block number (null if pending)",
        },
        {
          field: "transactionLink",
          description: "Explorer link to the transaction",
        },
        {
          field: "fromLink",
          description: "Explorer link to the sender address",
        },
        {
          field: "toLink",
          description: "Explorer link to the recipient address",
        },
        {
          field: "error",
          description: "Error message if the lookup failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "transactionHash",
          label: "Transaction Hash",
          type: "template-input",
          placeholder: "0x... or {{NodeName.transactionHash}}",
          example:
            "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060",
          required: true,
        },
      ],
    },
    {
      slug: "decode-calldata",
      label: "Decode Calldata",
      description:
        "Decode raw transaction calldata into human-readable function calls with parameter names and values",
      category: "Web3",
      stepFunction: "decodeCalldataStep",
      stepImportPath: "decode-calldata",
      outputFields: [
        {
          field: "success",
          description: "Whether decoding succeeded",
        },
        {
          field: "selector",
          description: "4-byte function selector (e.g., 0xa9059cbb)",
        },
        {
          field: "functionName",
          description:
            "Decoded function name (e.g., transfer), or null if unknown",
        },
        {
          field: "functionSignature",
          description:
            "Full function signature (e.g., transfer(address,uint256)), or null if unknown",
        },
        {
          field: "parameters",
          description: "Array of decoded parameters with name, type, and value",
        },
        {
          field: "decodingSource",
          description:
            "How the function was identified: explorer, 4byte, manual-abi, selector-only, or none",
        },
        {
          field: "error",
          description: "Error message if decoding failed",
        },
      ],
      configFields: [
        {
          key: "calldata",
          label: "Calldata",
          type: "template-input",
          placeholder: "0x... or {{NodeName.calldata}}",
          example:
            "0xa9059cbb0000000000000000000000001234567890abcdef1234567890abcdef12345678000000000000000000000000000000000000000000000000000000003b9aca00",
          required: true,
        },
        {
          key: "contractAddress",
          label: "Contract Address",
          type: "template-input",
          placeholder:
            "0x... or {{NodeName.contractAddress}} (optional, for ABI lookup)",
          example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        },
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network (required if contract address provided)",
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "abi",
              label: "ABI Override",
              type: "template-textarea",
              placeholder: "Paste ABI JSON to use instead of auto-fetching",
              rows: 4,
            },
          ],
        },
      ],
    },
    {
      slug: "assess-risk",
      label: "Assess Transaction Risk",
      description:
        "AI-powered risk assessment that analyzes transaction calldata, value, and context to produce a risk score with detailed factors",
      category: "Web3",
      stepFunction: "assessRiskStep",
      stepImportPath: "assess-risk",
      outputFields: [
        {
          field: "success",
          description: "Whether the assessment completed",
        },
        {
          field: "riskLevel",
          description: "Risk level: low, medium, high, or critical",
        },
        {
          field: "riskScore",
          description: "Numeric risk score from 0 (safe) to 100 (critical)",
        },
        {
          field: "factors",
          description: "Array of identified risk factors",
        },
        {
          field: "decodedFunction",
          description: "The decoded function signature, or null if unknown",
        },
        {
          field: "reasoning",
          description: "AI-generated explanation of the risk assessment",
        },
        {
          field: "error",
          description:
            "Error message if assessment failed (riskLevel will be critical)",
        },
      ],
      configFields: [
        {
          key: "calldata",
          label: "Transaction Calldata",
          type: "template-input",
          placeholder: "0x... or {{NodeName.calldata}}",
          example:
            "0xa9059cbb0000000000000000000000001234567890abcdef1234567890abcdef12345678ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          required: true,
        },
        {
          key: "contractAddress",
          label: "Contract Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.contractAddress}}",
          example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        },
        {
          key: "value",
          label: "Transaction Value",
          type: "template-input",
          placeholder: "0 or {{NodeName.value}}",
          example: "0",
        },
        {
          key: "chain",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
        },
        {
          key: "senderAddress",
          label: "Sender Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.sender}}",
        },
      ],
    },
    {
      slug: "query-events",
      label: "Query Contract Events",
      description:
        "Query historical smart contract events across a block range with automatic batching",
      category: "Web3",
      stepFunction: "queryEventsStep",
      stepImportPath: "query-events",
      outputFields: [
        {
          field: "success",
          description: "Whether the query succeeded",
        },
        {
          field: "events",
          description:
            "Array of decoded event objects with blockNumber, transactionHash, logIndex, and args",
        },
        {
          field: "fromBlock",
          description: "Actual start block used",
        },
        {
          field: "toBlock",
          description: "Actual end block used (resolved from latest)",
        },
        {
          field: "eventCount",
          description: "Number of events returned",
        },
        {
          field: "error",
          description: "Error message if the query failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "contractAddress",
          label: "Contract Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.contractAddress}}",
          example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          required: true,
        },
        {
          key: "abi",
          label: "Contract ABI",
          type: "abi-with-auto-fetch",
          contractAddressField: "contractAddress",
          contractInteractionType: "read",
          networkField: "network",
          rows: 6,
          required: true,
        },
        {
          key: "eventName",
          label: "Event Name",
          type: "abi-event-select",
          abiField: "abi",
          placeholder: "Select an event",
          required: true,
        },
        {
          type: "group",
          label: "Block Range",
          defaultExpanded: true,
          fields: [
            {
              key: "blockCount",
              label: "Block Lookback",
              type: "template-input",
              placeholder: "Number of blocks to look back (default: 6500)",
              helpTip:
                "How many blocks to scan backwards from the end block. Default: 6500 (~1 day on Ethereum). Ignored if From Block is set.",
            },
            {
              key: "fromBlock",
              label: "From Block",
              type: "template-input",
              placeholder: "Start block number",
              helpTip:
                "Explicit start block. If set, Block Lookback is ignored.",
            },
            {
              key: "toBlock",
              label: "To Block",
              type: "template-input",
              placeholder: "End block number (default: latest)",
              helpTip:
                "End block for the query. Defaults to the latest block if left empty.",
            },
          ],
        },
      ],
    },
    {
      slug: "query-transactions",
      label: "Query Transaction History",
      description:
        "Query historical transactions to a contract filtered by function calls and optionally by argument values. Uses block explorer APIs to find transactions when event logs are not available.",
      category: "Web3",
      stepFunction: "queryTransactionsStep",
      stepImportPath: "query-transactions",
      outputFields: [
        {
          field: "success",
          description: "Whether the query succeeded",
        },
        {
          field: "transactions",
          description:
            "Array of decoded transaction objects with hash, from, value, blockNumber, timestamp, functionName, and args",
        },
        {
          field: "fromBlock",
          description: "Actual start block used",
        },
        {
          field: "toBlock",
          description: "Actual end block used",
        },
        {
          field: "totalFetched",
          description:
            "Total transactions fetched from explorer before filtering",
        },
        {
          field: "matchCount",
          description:
            "Number of transactions matching the function and argument filters",
        },
        {
          field: "contractAddressLink",
          description: "Block explorer link for the contract",
        },
        {
          field: "error",
          description: "Error message if the query failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "contractAddress",
          label: "Contract Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.contractAddress}}",
          example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          required: true,
        },
        {
          key: "abi",
          label: "Contract ABI",
          type: "abi-with-auto-fetch",
          contractAddressField: "contractAddress",
          networkField: "network",
          rows: 6,
          required: true,
        },
        {
          key: "abiFunction",
          label: "Function",
          type: "abi-function-select",
          abiField: "abi",
          functionFilter: "write",
          placeholder: "Select a function to filter by",
          required: true,
        },
        {
          key: "functionArgs",
          label: "Function Arguments",
          type: "abi-function-args",
          abiField: "abi",
          abiFunctionField: "abiFunction",
          helpTip:
            "Optional: filter by specific argument values. Leave empty to match all calls to the selected function.",
        },
        {
          type: "group",
          label: "Block Range",
          defaultExpanded: true,
          fields: [
            {
              key: "blockCount",
              label: "Block Lookback",
              type: "template-input",
              placeholder: "Number of blocks to look back (default: 6500)",
              helpTip:
                "How many blocks to scan backwards from the end block. Default: 6500 (~1 day on Ethereum). Ignored if From Block is set.",
            },
            {
              key: "fromBlock",
              label: "From Block",
              type: "template-input",
              placeholder: "Start block number",
              helpTip:
                "Explicit start block. If set, Block Lookback is ignored.",
            },
            {
              key: "toBlock",
              label: "To Block",
              type: "template-input",
              placeholder: "End block number (default: latest)",
              helpTip:
                "End block for the query. Defaults to the latest block if left empty.",
            },
          ],
        },
      ],
    },
    {
      slug: "batch-read-contract",
      label: "Batch Read Contract",
      description:
        "Call the same contract function with multiple argument sets in a single RPC call using Multicall3",
      category: "Web3",
      stepFunction: "batchReadContractStep",
      stepImportPath: "batch-read-contract",
      outputFields: [
        {
          field: "success",
          description: "Whether the batch call succeeded",
        },
        {
          field: "results",
          description:
            "Array of results in call order, each with { success, result, error? }",
        },
        {
          field: "totalCalls",
          description: "Total number of calls executed",
        },
        {
          field: "error",
          description: "Error message if the entire batch failed",
        },
      ],
      configFields: [
        {
          key: "inputMode",
          label: "Input Mode",
          type: "select",
          options: [
            {
              value: "uniform",
              label: "Same function, multiple args",
            },
            {
              value: "mixed",
              label: "Different contracts/functions",
            },
          ],
          defaultValue: "uniform",
          required: true,
          helpTip:
            "Uniform: one contract + one function + array of arg sets. Mixed: each call has its own contract, function, and args.",
        },
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
          showWhen: { field: "inputMode", oneOf: ["uniform", ""] },
        },
        {
          key: "contractAddress",
          label: "Contract Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.contractAddress}}",
          example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          required: true,
          showWhen: { field: "inputMode", oneOf: ["uniform", ""] },
        },
        {
          key: "abi",
          label: "Contract ABI",
          type: "abi-with-auto-fetch",
          contractAddressField: "contractAddress",
          contractInteractionType: "read",
          networkField: "network",
          rows: 6,
          required: true,
          showWhen: { field: "inputMode", oneOf: ["uniform", ""] },
        },
        {
          key: "abiFunction",
          label: "Function",
          type: "abi-function-select",
          abiField: "abi",
          placeholder: "Select a function",
          required: true,
          showWhen: { field: "inputMode", oneOf: ["uniform", ""] },
        },
        {
          key: "argsList",
          label: "Args List",
          type: "args-list-builder",
          abiField: "abi",
          abiFunctionField: "abiFunction",
          helpTip:
            "Add argument sets for each call. Each row represents one call with the selected function's parameters.",
          showWhen: { field: "inputMode", oneOf: ["uniform", ""] },
        },
        {
          key: "calls",
          label: "Calls",
          type: "call-list-builder",
          required: true,
          helpTip:
            "Add contract calls to batch. Each call has its own network, contract address, ABI, function, and arguments.",
          showWhen: { field: "inputMode", equals: "mixed" },
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "batchSize",
              label: "Batch Size",
              type: "number",
              placeholder: "100",
              defaultValue: "100",
              min: 1,
              max: 500,
              helpTip:
                "Maximum calls per Multicall3 request. Lower values reduce RPC payload size.",
            },
          ],
        },
      ],
    },
    {
      slug: "approve-token",
      label: "Approve ERC20 Token",
      description:
        "Approve a spender contract to spend ERC20 tokens on behalf of your wallet (required before swaps and DeFi interactions)",
      category: "Web3",
      requiresCredentials: true,
      stepFunction: "approveTokenStep",
      stepImportPath: "approve-token",
      outputFields: [
        {
          field: "success",
          description: "Whether the approval succeeded",
        },
        {
          field: "transactionHash",
          description: "The transaction hash of the approval",
        },
        {
          field: "transactionLink",
          description: "Explorer link to view the transaction",
        },
        {
          field: "gasUsed",
          description: "Gas cost in wei",
        },
        {
          field: "approvedAmount",
          description:
            'The approved amount (human-readable, or "unlimited" for max approval)',
        },
        {
          field: "spender",
          description: "The spender address that was approved",
        },
        {
          field: "symbol",
          description: "The token symbol (e.g., USDC)",
        },
        {
          field: "error",
          description: "Error message if the approval failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "tokenConfig",
          label: "Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
        {
          key: "spenderAddress",
          label: "Spender Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
          required: true,
        },
        {
          key: "amount",
          label: "Amount",
          type: "template-input",
          placeholder: '100.50 or "max" for unlimited',
          example: "max",
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "approve-token",
            },
          ],
        },
      ],
    },
    {
      slug: "check-allowance",
      label: "Check ERC20 Allowance",
      description:
        "Check the current ERC20 token spending allowance granted by an owner to a spender",
      category: "Web3",
      stepFunction: "checkAllowanceStep",
      stepImportPath: "check-allowance",
      outputFields: [
        {
          field: "success",
          description: "Whether the allowance check succeeded",
        },
        {
          field: "allowance",
          description: "Current allowance in human-readable format",
        },
        {
          field: "allowanceRaw",
          description: "Current allowance in raw units (wei string)",
        },
        {
          field: "symbol",
          description: "The token symbol (e.g., USDC)",
        },
        {
          field: "error",
          description: "Error message if the check failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "tokenConfig",
          label: "Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
        {
          key: "ownerAddress",
          label: "Owner Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          required: true,
        },
        {
          key: "spenderAddress",
          label: "Spender Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
          required: true,
        },
      ],
    },
    {
      slug: "write-contract",
      label: "Write Contract",
      description: "Write data to a smart contract (state-changing functions)",
      category: "Web3",
      requiresCredentials: true,
      stepFunction: "writeContractStep",
      stepImportPath: "write-contract",
      outputFields: [
        {
          field: "success",
          description: "Whether the contract call succeeded",
        },
        {
          field: "transactionHash",
          description: "The transaction hash of the successful write",
        },
        {
          field: "result",
          description: "The contract function return value (if any)",
        },
        {
          field: "error",
          description: "Error message if the call failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "contractAddress",
          label: "Contract Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.contractAddress}}",
          example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          required: true,
        },
        {
          key: "abi",
          label: "Contract ABI",
          type: "abi-with-auto-fetch",
          contractAddressField: "contractAddress",
          contractInteractionType: "write",
          networkField: "network",
          rows: 6,
          required: true,
        },
        {
          key: "abiFunction",
          label: "Function",
          type: "abi-function-select",
          abiField: "abi",
          functionFilter: "write",
          placeholder: "Select a function",
          required: true,
        },
        {
          key: "functionArgs",
          label: "Function Arguments",
          type: "abi-function-args",
          abiField: "abi",
          abiFunctionField: "abiFunction",
        },
        {
          key: "ethValue",
          label: "Payable Value",
          type: "template-input",
          placeholder: "0.0",
          helpTip:
            "Amount of native token (e.g. ETH, MATIC) to send with this payable function call. Specified in whole units, not wei.",
          showWhen: {
            computed: "abiFunctionMutability",
            abiField: "abi",
            functionField: "abiFunction",
            equals: "payable",
          },
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "write-contract",
            },
          ],
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(web3Plugin);

export default web3Plugin;
