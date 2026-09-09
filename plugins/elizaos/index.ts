import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { ElizaOSIcon } from "./icon";

const elizaosPlugin: IntegrationPlugin = {
  type: "elizaos",
  egress: "user-destination",
  label: "ElizaOS",
  description: "Trigger actions and dispatch intents to autonomous ElizaOS agent servers",

  icon: ElizaOSIcon,
  requiresCredentials: true,

  formFields: [
    {
      id: "endpointUrl",
      label: "ElizaOS Server URL",
      type: "url",
      placeholder: "https://agent.example.com",
      configKey: "endpointUrl",
      envVar: "ELIZAOS_ENDPOINT_URL",
      helpText: "The public base URL of your running ElizaOS agent server.",
    },
    {
      id: "apiKey",
      label: "Agent Auth Token (Optional)",
      type: "password",
      placeholder: "Bearer token if required",
      configKey: "apiKey",
      envVar: "ELIZAOS_API_KEY",
      helpText: "Bearer token if your ElizaOS server is secured with authentication.",
    },
    {
      id: "agentId",
      label: "Default Agent ID (Optional)",
      type: "text",
      placeholder: "e.g. 123e4567-e89b-12d3-a456-426614174000",
      configKey: "agentId",
      envVar: "ELIZAOS_AGENT_ID",
      helpText: "Default agent character UUID to target if not overridden in action configuration.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testElizaOS } = await import("./test");
      return testElizaOS;
    },
  },

  actions: [
    {
      slug: "execute-agent-action",
      label: "Trigger Agent Action",
      description: "Dispatch an intent or action payload to an ElizaOS agent",
      category: "AI Agents",
      stepFunction: "executeAgentActionStep",
      stepImportPath: "execute-agent-action",
      outputFields: [
        { field: "success", description: "Whether the agent action executed successfully" },
        { field: "response", description: "Agent response or action output payload" },
        { field: "error", description: "Error description if execution failed" },
        { field: "errorClass", description: "Fault domain category (user, system, external)" },
      ],
      configFields: [
        {
          key: "action",
          label: "Action Name",
          type: "template-input",
          placeholder: "e.g. EXECUTE_ONCHAIN_KEEPERHUB or REBALANCE_DEFI",
          helpTip: "The action handler or intent to trigger in ElizaOS.",
          required: true,
        },
        {
          key: "agentId",
          label: "Agent ID",
          type: "template-input",
          placeholder: "e.g. 123e4567-e89b-12d3-a456-426614174000 or {{NodeName.agentId}}",
          helpTip: "Target agent character UUID identifier. Required.",
          required: true,
        },
        {
          key: "payload",
          label: "Payload JSON",
          type: "template-input",
          placeholder: '{"protocol": "aave-v3", "minHealthFactor": 1.5}',
          helpTip: "JSON payload containing parameters for the agent.",
          required: false,
        },
        {
          key: "userId",
          label: "User ID (Optional)",
          type: "template-input",
          placeholder: "e.g. 123e4567-e89b-12d3-a456-426614174001",
          helpTip: "Optional UUID of the caller for v1 messaging sessions. Defaults to a generated UUID.",
          required: false,
        },
        {
          key: "path",
          label: "Endpoint Path (Optional)",
          type: "template-input",
          placeholder: "e.g. /api/agents/{agentId}/plugins/my-plugin",
          helpTip: "Optional custom endpoint path for plugin-mounted routes. Supports {agentId} token replacement. If omitted, defaults to the ElizaOS v1 Sessions API (/api/messaging/sessions).",
          required: false,
        },
      ],
    },
  ],
};

registerIntegration(elizaosPlugin);

export default elizaosPlugin;
