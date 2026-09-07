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
      placeholder: "e.g. default",
      configKey: "agentId",
      envVar: "ELIZAOS_AGENT_ID",
      helpText: "Default agent character identifier to target if not overridden in action configuration.",
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
      ],
      configFields: [
        {
          key: "action",
          label: "Action Name",
          type: "template-input",
          placeholder: "e.g. EXECUTE_ONCHAIN_KEEPERHUB or REBALANCE_DEFI",
          helpTip: "The action handler registered in the ElizaOS runtime.",
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
          key: "agentId",
          label: "Agent ID (Optional)",
          type: "template-input",
          placeholder: "e.g. default or {{NodeName.agentId}}",
          helpTip: "Target agent character identifier. If omitted, falls back to connection default.",
          required: false,
        },
      ],
    },
  ],
};

registerIntegration(elizaosPlugin);

export default elizaosPlugin;
