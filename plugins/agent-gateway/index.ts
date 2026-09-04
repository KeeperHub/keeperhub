import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry-core";
import AgentGatewayIcon from "./icon";

const agentGatewayPlugin: IntegrationPlugin = {
  type: "agent-gateway",
  egress: "fixed-host",
  label: "Agent Gateway",
  description:
    "Read an agent sub-org's KeeperHub credit balance and request Turnkey-backed signatures for x402 (Base) / MPP (Tempo) payment challenges",

  icon: AgentGatewayIcon,

  formFields: [
    {
      id: "subOrgId",
      label: "Sub-Org ID",
      type: "text",
      placeholder: "e.g. su-...",
      configKey: "subOrgId",
      envVar: "AGENT_GATEWAY_SUB_ORG_ID",
      helpText:
        "Obtained once from POST /api/agentic-wallet/provision. There is no in-app provisioning step - provision out-of-band and paste the returned subOrgId and hmacSecret here.",
    },
    {
      id: "hmacSecret",
      label: "HMAC Secret",
      type: "password",
      configKey: "hmacSecret",
      envVar: "AGENT_GATEWAY_HMAC_SECRET",
      helpText:
        "The hmacSecret returned alongside subOrgId by POST /api/agentic-wallet/provision. Never re-displayed by that endpoint - store it here when you provision.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testAgentGateway } = await import("./test");
      return testAgentGateway;
    },
  },

  actions: [
    {
      slug: "check-credit",
      label: "Check Credit Balance",
      description:
        "Read the agent sub-org's off-chain KeeperHub credit balance",
      category: "Agent Gateway",
      stepFunction: "checkCreditStep",
      stepImportPath: "check-credit",
      outputFields: [
        { field: "success", description: "Whether the read succeeded" },
        { field: "amount", description: "Credit balance as a USD decimal string" },
        { field: "currency", description: "Currency of the balance (USD)" },
        {
          field: "subOrgId",
          description: "The sub-org the balance was read for",
        },
      ],
      configFields: [],
    },
    {
      slug: "sign-payment",
      label: "Sign Payment Challenge",
      description:
        "Request a Turnkey-backed signature for an x402 (Base) or MPP (Tempo) payment challenge for a KeeperHub marketplace workflow. Payee and amount are derived from the workflow registry by slug. May return a pending-approval result instead of a signature depending on the sub-org's risk policy.",
      category: "Agent Gateway",
      stepFunction: "signPaymentStep",
      stepImportPath: "sign-payment",
      outputFields: [
        { field: "success", description: "Whether a signature was produced" },
        { field: "status", description: "\"signed\" | \"pending_approval\" | \"blocked\" | \"error\"" },
        { field: "approvalRequestId", description: "Present when status is \"pending_approval\"" },
      ],
      configFields: [
        {
          key: "chain",
          label: "Chain",
          type: "select",
          options: [
            { label: "Base (x402)", value: "base" },
            { label: "Tempo (MPP)", value: "tempo" },
          ],
          required: true,
        },
        {
          key: "paymentChallenge",
          label: "Payment Challenge",
          type: "json-editor",
          required: true,
          helpTip:
            "The 402/WWW-Authenticate payment challenge payload. Must belong to a KeeperHub marketplace workflow; payTo and amount are verified against the workflow registry.",
        },
        {
          key: "workflowSlug",
          label: "Workflow Slug",
          type: "template-input",
          required: true,
          helpTip:
            "The slug of the KeeperHub marketplace workflow being paid for. Required: /api/agentic-wallet/sign derives the payee and amount from the workflows registry by slug.",
        },
      ],
    },
  ],
};

registerIntegration(agentGatewayPlugin);

export default agentGatewayPlugin;
