/**
 * Tempo demo workflow templates.
 *
 * Three deployable, publicly-listed templates that exercise the Tempo plugin
 * end to end: Invoice Reconciliation (payment-received trigger + memo match),
 * Contractor Batch Payroll (atomic batch payout), and Treasury Sweep (DEX swap
 * plus windowed disbursement). Seeded via seed-tempo-templates.ts and surfaced
 * through /api/workflows/public + MCP deploy_template.
 *
 * Clone-time fields (deposit address, payee API, recipients, amounts, notify
 * email) are seeded as `{{placeholder}}` tokens rather than empty strings: an
 * empty required field makes the cloned workflow fail save-validation, whereas
 * a template token passes validation and reads as "replace me". The cloner
 * swaps each token for a concrete value or an upstream-node reference. Seeded
 * against Tempo Moderato testnet (42431); to point a clone at mainnet, flip the
 * network to 4217 and swap the token addresses.
 */

import { computeAutoLayout } from "@/lib/workflow/editor/auto-layout";
import {
  buildActionNode,
  buildConditionNode,
  buildEdge,
  buildTriggerNode,
  type WorkflowNodeJson,
} from "@/lib/workflow/node-builders";

const TEMPO_TESTNET = "42431";
// PathUSD (enshrined) and AlphaUSD on Moderato, both 6-decimal stablecoins.
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const ALPHA_USD = "0x20c0000000000000000000000000000000000001";

export type TempoTemplateFixture = {
  id: string;
  listedSlug: string;
  name: string;
  description: string;
  category: string;
  chain: string;
  inputSchema: Record<string, unknown>;
  nodes: unknown[];
  edges: unknown[];
};

/**
 * Email notification node. Built inline (not via `buildEmailNode`) so the
 * config carries only the action's own fields. `buildEmailNode` also writes
 * `useKeeperHubApiKey`, which is a plugin form field rather than an action
 * config field: the save-time validator rejects it as an unknown field, and it
 * cannot be cleared from the node config panel. The send-email step always uses
 * the KeeperHub API key regardless, so omitting it changes nothing at runtime.
 */
function buildTempoEmailNode(
  id: string,
  to: string,
  subject: string,
  body: string,
  yOffset: number
): WorkflowNodeJson {
  return buildActionNode(
    id,
    "Send Email Alert",
    "Send an email notification",
    {
      actionType: "sendgrid/send-email",
      emailTo: to,
      emailSubject: subject,
      emailBody: body,
    },
    yOffset
  );
}

function withAutoLayout(fixture: TempoTemplateFixture): TempoTemplateFixture {
  const positions = computeAutoLayout(
    fixture.nodes as unknown as Parameters<typeof computeAutoLayout>[0],
    fixture.edges as unknown as Parameters<typeof computeAutoLayout>[1]
  );
  const nodes = (fixture.nodes as WorkflowNodeJson[]).map((node) => {
    const pos = positions.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });
  return { ...fixture, nodes };
}

const RAW_FIXTURES: TempoTemplateFixture[] = [
  {
    id: "tempo-invoice-reconciliation",
    listedSlug: "tempo-invoice-reconciliation",
    name: "Tempo Invoice Reconciliation",
    description:
      "When a stablecoin payment lands on your Tempo deposit address whose memo matches an open invoice, mark it paid in your accounting system and email the customer a receipt.",
    category: "Payments",
    chain: TEMPO_TESTNET,
    inputSchema: {
      type: "object",
      properties: {
        depositAddress: {
          type: "string",
          description: "Your Tempo deposit address to watch for payments",
        },
        accountingApiUrl: {
          type: "string",
          description: "URL your workflow POSTs to when an invoice is paid",
        },
        notifyEmail: {
          type: "string",
          description: "Email address that receives the payment receipt",
        },
      },
      required: ["depositAddress"],
    },
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Transfer",
        network: TEMPO_TESTNET,
        contractAddress: PATH_USD,
        recipientAddress: "",
        memo: "",
      }),
      buildConditionNode(
        "step-1",
        {
          condition: "{{@trigger-1:Transfer.args.value}} >= 0",
          group: {
            id: "group-1",
            logic: "AND",
            rules: [
              {
                id: "rule-1",
                leftOperand:
                  "{{@trigger-1:Transfer.args.value}}",
                operator: ">=",
                rightOperand: "0",
              },
            ],
          },
        },
        400
      ),
      buildActionNode(
        "step-2",
        "Mark Invoice Paid",
        "POST to your accounting API to mark the invoice paid",
        {
          actionType: "HTTP Request",
          method: "POST",
          url: "{{accountingApiUrl}}",
          body: '{"memo":"{{@trigger-1:Transfer.args.memo}}","amount":"{{@trigger-1:Transfer.args.value}}"}',
        },
        600
      ),
      buildTempoEmailNode(
        "step-3",
        "{{notifyEmail}}",
        "Payment received",
        "We received your payment on Tempo. View it on explore.testnet.tempo.xyz. Thank you!",
        800
      ),
    ],
    edges: [
      buildEdge("trigger-1", "step-1"),
      buildEdge("step-1", "step-2", "true"),
      buildEdge("step-2", "step-3"),
    ],
  },

  {
    id: "tempo-contractor-batch-payroll",
    listedSlug: "tempo-contractor-batch-payroll",
    name: "Tempo Contractor Batch Payroll",
    description:
      "On the first of every month, pay your contractors their stablecoin amounts on Tempo in a single atomic batch transaction, each stamped with the pay-run id, and email yourself the confirmation.",
    category: "Payments",
    chain: TEMPO_TESTNET,
    inputSchema: {
      type: "object",
      properties: {
        payeeApiUrl: {
          type: "string",
          description: "URL returning the approved payee list as JSON",
        },
        notifyEmail: {
          type: "string",
          description: "Email address that receives the payroll confirmation",
        },
      },
      required: [],
    },
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 9 1 * *",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Fetch Payees",
        "Fetch the approved payee list from your payroll API",
        { actionType: "HTTP Request", method: "GET", url: "{{payeeApiUrl}}" },
        400
      ),
      buildActionNode(
        "step-2",
        "Batch Payout",
        "Pay all contractors in one atomic Tempo transaction",
        {
          actionType: "tempo/batch-payout",
          network: TEMPO_TESTNET,
          tokenConfig: PATH_USD,
          payouts: "{{@step-1:Fetch Payees.body}}",
          memo: "PAYRUN",
        },
        600
      ),
      buildActionNode(
        "step-3",
        "Confirm Transaction",
        "Fetch the batch transaction details",
        {
          actionType: "web3/get-transaction",
          network: TEMPO_TESTNET,
          transactionHash: "{{@step-2:Batch Payout.transactionHash}}",
        },
        800
      ),
      buildTempoEmailNode(
        "step-4",
        "{{notifyEmail}}",
        "Payroll run complete",
        "Your contractor payroll ran on Tempo. Transaction: {{@step-2:Batch Payout.transactionLink}}",
        1000
      ),
    ],
    edges: [
      buildEdge("trigger-1", "step-1"),
      buildEdge("step-1", "step-2"),
      buildEdge("step-2", "step-3"),
      buildEdge("step-3", "step-4"),
    ],
  },

  {
    id: "tempo-treasury-sweep",
    listedSlug: "tempo-treasury-sweep",
    name: "Tempo Treasury Sweep",
    description:
      "Every morning, if your Tempo operating wallet holds more than your buffer, swap the excess into your treasury stablecoin on the native DEX and schedule the owner disbursement to land during business hours.",
    category: "Treasury",
    chain: TEMPO_TESTNET,
    inputSchema: {
      type: "object",
      properties: {
        operatingWallet: {
          type: "string",
          description: "The operating wallet whose balance is swept",
        },
        excessAmount: {
          type: "string",
          description: "Amount of the operating stablecoin to swap into treasury",
        },
        disbursementAmount: {
          type: "string",
          description: "Amount to disburse to the owner after the swap",
        },
        disbursementRecipient: {
          type: "string",
          description: "Owner address that receives the scheduled disbursement",
        },
      },
      required: [],
    },
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 8 * * *",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Check Balance",
        "Read the operating wallet's stablecoin balance",
        {
          actionType: "web3/check-token-balance",
          network: TEMPO_TESTNET,
          address: "{{operatingWallet}}",
          tokenConfig: PATH_USD,
        },
        400
      ),
      buildConditionNode(
        "step-2",
        {
          condition:
            "{{@step-1:Check Balance.balance.balanceRaw}} > 50000000000",
          group: {
            id: "group-1",
            logic: "AND",
            rules: [
              {
                id: "rule-1",
                leftOperand:
                  "{{@step-1:Check Balance.balance.balanceRaw}}",
                operator: ">",
                rightOperand: "50000000000",
              },
            ],
          },
        },
        600
      ),
      buildActionNode(
        "step-3",
        "Swap Excess",
        "Swap the excess into the treasury stablecoin on the native DEX",
        {
          actionType: "tempo/dex-swap",
          network: TEMPO_TESTNET,
          tokenInConfig: PATH_USD,
          tokenOutConfig: ALPHA_USD,
          amountIn: "{{excessAmount}}",
          slippageBps: 50,
        },
        800
      ),
      buildActionNode(
        "step-4",
        "Send Disbursement",
        "Send the owner disbursement on Tempo",
        {
          actionType: "tempo/transfer-with-memo",
          network: TEMPO_TESTNET,
          tokenConfig: ALPHA_USD,
          amount: "{{disbursementAmount}}",
          recipientAddress: "{{disbursementRecipient}}",
          memo: "owner-disbursement",
        },
        1000
      ),
    ],
    edges: [
      buildEdge("trigger-1", "step-1"),
      buildEdge("step-1", "step-2"),
      buildEdge("step-2", "step-3", "true"),
      buildEdge("step-3", "step-4"),
    ],
  },

  {
    id: "tempo-recurring-payment",
    listedSlug: "tempo-recurring-payment",
    name: "Tempo Recurring Payment",
    description:
      "On a recurring schedule, send a fixed stablecoin payment on Tempo to a recipient. The payment is signed fresh at send time, so its gas and nonce are always current -- schedule the send rather than holding a pre-signed transaction.",
    category: "Payments",
    chain: TEMPO_TESTNET,
    inputSchema: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "Address that receives the recurring payment",
        },
        amount: {
          type: "string",
          description: "Amount of the stablecoin to send each run",
        },
      },
      required: [],
    },
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 9 * * 1",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Send Payment",
        "Send the recurring stablecoin payment on Tempo",
        {
          actionType: "tempo/transfer-with-memo",
          network: TEMPO_TESTNET,
          tokenConfig: PATH_USD,
          amount: "{{amount}}",
          recipientAddress: "{{recipient}}",
          memo: "recurring-payment",
        },
        400
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1")],
  },
];

export const TEMPO_TEMPLATE_FIXTURES: TempoTemplateFixture[] =
  RAW_FIXTURES.map(withAutoLayout);
