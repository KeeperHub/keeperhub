import type { IntegrationPlugin } from "@/plugins/registry";
import {
  amountField,
  fromWalletOutput,
  tempoChainIdOutput,
  tokenConfigField,
  transactionLinkOutput,
  transferAmountOutput,
  transferErrorOutput,
  transferSuccessOutput,
} from "@/plugins/field-fragments";
import { registerIntegration } from "@/plugins/registry-core";
import { TempoIcon } from "./icon";

// Tempo networks: mainnet 4217, Moderato testnet 42431. Both are stablecoin
// EVM chains with no native gas token, so every network picker on this plugin
// is pinned to just these two.
const TEMPO_CHAIN_IDS = ["4217", "42431"];

const tempoPlugin: IntegrationPlugin = {
  type: "tempo",
  egress: "fixed-host",
  label: "Tempo",
  description:
    "Send stablecoin payments on Tempo with on-chain memos and atomic batch payouts, using your KeeperHub wallet",

  icon: TempoIcon,

  // One wallet per organization; write actions check for the wallet at
  // execution time.
  singleConnection: true,
  requiresCredentials: false,
  formFields: [],

  actions: [
    {
      slug: "transfer-with-memo",
      label: "Transfer with Memo",
      description:
        "Send a TIP-20 stablecoin payment on Tempo carrying an on-chain bytes32 memo (e.g. an invoice or pay-run reference)",
      category: "Tempo",
      stepFunction: "transferWithMemoStep",
      stepImportPath: "transfer-with-memo",
      outputFields: [
        transferSuccessOutput(),
        {
          field: "transactionHash",
          description: "The transaction hash of the transfer",
        },
        transactionLinkOutput(),
        fromWalletOutput(),
        { field: "to", description: "The recipient address" },
        transferAmountOutput(),
        {
          field: "memo",
          description: "The bytes32 memo attached to the transfer",
        },
        {
          field: "validBefore",
          description:
            "On-chain expiry enforced (unix seconds), or null if none set",
        },
        tempoChainIdOutput(),
        transferErrorOutput(),
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          allowedChainIds: TEMPO_CHAIN_IDS,
          placeholder: "Select a Tempo network",
          required: true,
        },
        tokenConfigField(),
        amountField(),
        {
          key: "recipientAddress",
          label: "Recipient Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          required: true,
        },
        {
          key: "memo",
          label: "Memo",
          type: "template-input",
          placeholder: "INV-1042 or 0x... (32-byte hex)",
          helpTip:
            "Attached on-chain as an indexed bytes32 topic. Plain text (<= 31 bytes) is utf8-encoded; a 0x + 64-hex value is used verbatim (e.g. a receipt hash).",
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "validBefore",
              label: "Expire if not settled by",
              type: "datetime",
              helpTip:
                "Optional on-chain expiry: if the transfer is not included by this time it fails instead of lingering. A fixed date+timezone, a relative offset (e.g. +15m from the run), or a value from another step. Leave blank for no expiry.",
            },
          ],
        },
      ],
    },
    {
      slug: "batch-payout",
      label: "Batch Payout",
      description:
        "Pay many recipients in one atomic Tempo transaction, each payment stamped with its own memo. All payments settle together or none do.",
      category: "Tempo",
      stepFunction: "batchPayoutStep",
      stepImportPath: "batch-payout",
      outputFields: [
        { field: "success", description: "Whether the batch payout succeeded" },
        {
          field: "transactionHash",
          description: "The transaction hash of the atomic batch",
        },
        transactionLinkOutput(),
        fromWalletOutput(),
        {
          field: "payoutCount",
          description: "Number of payments included in the batch",
        },
        {
          field: "totalAmount",
          description: "Total amount paid across the batch (human-readable)",
        },
        tempoChainIdOutput(),
        {
          field: "error",
          description: "Error message if the batch payout failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          allowedChainIds: TEMPO_CHAIN_IDS,
          placeholder: "Select a Tempo network",
          required: true,
        },
        tokenConfigField(),
        {
          key: "payouts",
          label: "Payouts",
          type: "template-textarea",
          placeholder:
            '[{"recipient":"0x...","amount":"100.50","memo":"INV-1042"}] or {{NodeName.payouts}}',
          helpTip:
            'JSON array of payments. Each entry needs "recipient" and "amount"; "memo" is optional and falls back to the shared memo below.',
          rows: 6,
          required: true,
        },
        {
          key: "memo",
          label: "Shared Memo",
          type: "template-input",
          placeholder: "PAYRUN-2026-07 or {{NodeName.payRunId}}",
          helpTip:
            "Applied to every payment that does not set its own memo (e.g. a pay-run id).",
        },
      ],
    },
    {
      slug: "dex-swap",
      label: "Swap Stablecoins",
      description:
        "Market-swap one Tempo stablecoin for another on the enshrined DEX, protected by a minimum-output slippage floor",
      category: "Tempo",
      stepFunction: "dexSwapStep",
      stepImportPath: "dex-swap",
      outputFields: [
        { field: "success", description: "Whether the swap succeeded" },
        {
          field: "transactionHash",
          description: "The transaction hash of the swap",
        },
        transactionLinkOutput(),
        { field: "from", description: "The swapping wallet address" },
        { field: "tokenIn", description: "Symbol of the token sold" },
        { field: "tokenOut", description: "Symbol of the token bought" },
        { field: "amountIn", description: "Amount sold (human-readable)" },
        {
          field: "quotedOut",
          description: "Quoted output amount at execution time (human-readable)",
        },
        {
          field: "minAmountOut",
          description:
            "Minimum output enforced after slippage (human-readable)",
        },
        tempoChainIdOutput(),
        { field: "error", description: "Error message if the swap failed" },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          allowedChainIds: TEMPO_CHAIN_IDS,
          placeholder: "Select a Tempo network",
          required: true,
        },
        {
          key: "tokenInConfig",
          label: "Sell Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
        {
          key: "tokenOutConfig",
          label: "Buy Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
        {
          key: "amountIn",
          label: "Amount to Sell",
          type: "template-input",
          placeholder: "1000 or {{NodeName.amount}}",
          example: "1000",
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "slippageBps",
              label: "Max Slippage (bps)",
              type: "number",
              placeholder: "50",
              defaultValue: "50",
              min: 0,
              max: 9999,
              helpTip:
                "Maximum slippage in basis points (50 = 0.5%). The swap reverts if the output falls below this floor.",
            },
          ],
        },
      ],
    },
    {
      slug: "hold-payment",
      label: "Sign & Hold Payment",
      description:
        "Sign a stablecoin payment now and hold the signed transaction to broadcast later, on demand or at a scheduled time. The on-chain validity window guarantees it can never settle after its deadline.",
      category: "Tempo",
      stepFunction: "holdPaymentStep",
      stepImportPath: "hold-payment",
      outputFields: [
        { field: "success", description: "Whether the payment was held" },
        {
          field: "paymentId",
          description:
            "Id of the held payment, used later to broadcast or cancel it",
        },
        {
          field: "precomputedHash",
          description: "The transaction hash the signed payment will settle as",
        },
        fromWalletOutput(),
        { field: "to", description: "The recipient address" },
        { field: "amount", description: "The amount held (human-readable)" },
        {
          field: "memo",
          description: "The bytes32 memo attached to the payment",
        },
        {
          field: "broadcastMode",
          description: "Whether the hold is released manually or on a schedule",
        },
        {
          field: "broadcastAt",
          description: "Scheduled broadcast time (ISO), or null for manual",
        },
        {
          field: "validBefore",
          description:
            "On-chain deadline after which the payment can no longer settle (unix seconds)",
        },
        { field: "status", description: "The held payment status (pending)" },
        tempoChainIdOutput(),
        { field: "error", description: "Error message if the hold failed" },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          allowedChainIds: TEMPO_CHAIN_IDS,
          placeholder: "Select a Tempo network",
          required: true,
        },
        tokenConfigField(),
        amountField(),
        {
          key: "recipientAddress",
          label: "Recipient Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
          required: true,
        },
        {
          key: "memo",
          label: "Memo",
          type: "template-input",
          placeholder: "INV-1042 or 0x... (32-byte hex)",
          helpTip: "Attached on-chain as an indexed bytes32 topic.",
        },
        {
          key: "broadcastMode",
          label: "Release",
          type: "select",
          defaultValue: "manual",
          options: [
            { value: "manual", label: "Manually (Broadcast Held Payment)" },
            { value: "schedule", label: "At a scheduled time" },
          ],
          helpTip:
            "Manual holds are released from the Held Payments page by an organization owner. Scheduled holds fire automatically at the broadcast time.",
        },
        {
          type: "group",
          label: "Scheduling",
          defaultExpanded: false,
          fields: [
            {
              key: "broadcastAt",
              label: "Broadcast At",
              type: "datetime",
              helpTip:
                "Required when Release is 'At a scheduled time'. A fixed date+timezone, a relative offset (e.g. +2h from the run), or a value from another step.",
            },
            {
              key: "validBefore",
              label: "Valid Before",
              type: "datetime",
              helpTip:
                "On-chain deadline after which the payment can no longer settle. A fixed date, a relative offset (e.g. +1h from the run), or a value from another step. Defaults to 24 hours from now (manual) or 1 hour past the broadcast time (scheduled).",
            },
          ],
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(tempoPlugin);

export default tempoPlugin;
