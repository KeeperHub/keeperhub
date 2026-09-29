import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { LucidIcon } from "./icon";

const agentUrlField = {
  key: "agentUrl",
  label: "Agent URL",
  type: "template-input" as const,
  placeholder: "https://agent.example.com",
  example: "https://agent.example.com",
  required: true,
};

const lucidPlugin: IntegrationPlugin = {
  type: "lucid",
  egress: "user-destination",
  label: "Lucid Agents",
  description:
    "Discover and call Lucid agent entrypoints. Priced entrypoints return their x402 payment terms; this plugin never signs or pays",

  icon: LucidIcon,

  // Lucid agent cards and entrypoints are public; the agent URL is set per action.
  requiresCredentials: false,
  formFields: [],

  actions: [
    {
      slug: "discover-agent",
      label: "Discover Agent",
      description:
        "Read a Lucid agent's card at /.well-known/agent-card.json and list its entrypoints, which ones are priced, and what they cost in the asset's base units",
      category: "Lucid Agents",
      stepFunction: "discoverAgentStep",
      stepImportPath: "discover-agent",
      outputFields: [
        { field: "success", description: "Whether the card was read" },
        { field: "name", description: "Agent name" },
        { field: "description", description: "Agent description" },
        {
          field: "entrypoints",
          description:
            "Entrypoints: name, description, priced, price (base units), asset, network, payTo, inputSchema",
        },
        {
          field: "pricedEntrypoints",
          description: "Keys of the entrypoints that require payment",
        },
        {
          field: "extensions",
          description: "Protocol extensions the agent declares",
        },
        { field: "error", description: "Error message if the read failed" },
      ],
      configFields: [agentUrlField],
    },
    {
      slug: "call-entrypoint",
      label: "Call Entrypoint",
      description:
        "Invoke a Lucid agent entrypoint. A free entrypoint returns its output. A priced one returns status \"awaiting_payment\" with the x402 terms, so a later step can decide whether to pay; pass the signed payment back in Payment Header to make the paid call. This action never signs or pays on its own",
      category: "Lucid Agents",
      stepFunction: "callEntrypointStep",
      stepImportPath: "call-entrypoint",
      outputFields: [
        { field: "success", description: "Whether the call completed or returned a quote" },
        {
          field: "status",
          description: "\"completed\" or \"awaiting_payment\"",
        },
        { field: "output", description: "Entrypoint output when completed" },
        {
          field: "payment",
          description:
            "First x402 payment requirement when payment is required: scheme, network, amount (base units), asset, payTo, resource",
        },
        {
          field: "paymentRequired",
          description: "The full x402 challenge as served, to hand to a signer",
        },
        { field: "paid", description: "Whether a payment header was sent" },
        {
          field: "paymentResponse",
          description: "Decoded x402 settlement receipt, when returned",
        },
        { field: "httpStatus", description: "HTTP status from the agent" },
        { field: "error", description: "Error message if the call failed" },
      ],
      configFields: [
        agentUrlField,
        {
          key: "entrypoint",
          label: "Entrypoint",
          type: "template-input",
          placeholder: "e.g. echo or {{DiscoverAgent.pricedEntrypoints[0]}}",
          example: "echo",
          required: true,
        },
        {
          key: "input",
          label: "Input JSON",
          type: "template-input",
          placeholder: '{"text": "hello"}',
          required: false,
        },
        {
          key: "paymentHeader",
          label: "Payment Header (Optional)",
          type: "template-input",
          placeholder: "{{PaymentPolicy.paymentHeader}}",
          helpTip:
            "A signed x402 payment payload produced by an earlier step that approved the payment. Sent as PAYMENT-SIGNATURE and X-PAYMENT. Leave empty to get the price without paying.",
          required: false,
        },
      ],
    },
  ],
};

registerIntegration(lucidPlugin);

export default lucidPlugin;
