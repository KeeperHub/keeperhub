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
        "Read a Lucid agent's card at /.well-known/agent-card.json and list its entrypoints, which ones are priced, and what they cost",
      category: "Lucid Agents",
      stepFunction: "discoverAgentStep",
      stepImportPath: "discover-agent",
      outputFields: [
        { field: "success", description: "Whether the card was read" },
        { field: "name", description: "Agent name" },
        { field: "description", description: "Agent description" },
        { field: "version", description: "Agent version" },
        {
          field: "entrypoints",
          description:
            "Entrypoints: name, description, priced, price, priceUnit (usd, base_units or unknown), asset, network, payTo, inputSchema",
        },
        {
          field: "pricedEntrypoints",
          description: "Names of the priced entrypoints",
        },
        { field: "httpStatus", description: "HTTP status from the agent" },
        { field: "error", description: "Error message if the read failed" },
      ],
      configFields: [agentUrlField],
    },
    {
      slug: "call-entrypoint",
      label: "Call Entrypoint",
      description:
        "Invoke a Lucid agent entrypoint. A free entrypoint returns its output. A priced one does not run: the agent answers with its x402 terms, returned with status \"awaiting_payment\". This action never signs or pays",
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
          field: "agentStatus",
          description:
            'The run status the agent reported, when it reported one. Only "succeeded" completes the step',
        },
        {
          field: "payment",
          description:
            "First x402 payment requirement when payment is required: scheme, network, offerCount, amount (integer base units, absent unless the challenge stated exactly one amount), amountRejected, asset, assetDecimals, assetMismatch, payTo, resource, description, maxTimeoutSeconds",
        },
        {
          field: "challenge",
          description: "The full x402 challenge as the agent served it",
        },
        { field: "runId", description: "The agent's run id when completed" },
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
          type: "template-textarea",
          valueFormat: "json",
          placeholder: '{"text": "hello"}',
          rows: 4,
          required: false,
        },
      ],
    },
  ],
};

registerIntegration(lucidPlugin);

export default lucidPlugin;
