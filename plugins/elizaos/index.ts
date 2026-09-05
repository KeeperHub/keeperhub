import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { ElizaOSIcon } from "./icon";

const elizaosPlugin: IntegrationPlugin = {
  type: "elizaos",
  egress: "user-destination",
  label: "ElizaOS Agent",
  description: "Connect autonomous AI agents to KeeperHub for deterministic DeFi risk execution and workflow triggers",

  icon: ElizaOSIcon,
  requiresCredentials: true,

  formFields: [
    {
      id: "endpointUrl",
      label: "ElizaOS Server URL",
      type: "url",
      placeholder: "http://localhost:3000 or https://your-agent.up.railway.app",
      configKey: "endpointUrl",
      helpText: "The base URL where your ElizaOS runtime server is hosted.",
    },
    {
      id: "apiKey",
      label: "Agent Auth Token (Optional)",
      type: "password",
      placeholder: "ey...",
      configKey: "apiKey",
      helpText: "Bearer token if your ElizaOS server is secured with authentication.",
    },
    {
      id: "agentId",
      label: "Default Agent ID",
      type: "text",
      placeholder: "e.g. sentinel-agent-1",
      configKey: "agentId",
      helpText: "Default agent character identifier to target.",
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
      description: "Dispatch an on-chain reasoning or execution intent to an ElizaOS agent",
      category: "AI Agents",
      stepFunction: "executeAgentActionStep",
      stepImportPath: "execute-agent-action",
      outputFields: [
        { field: "success", description: "Whether the agent executed successfully" },
        { field: "response", description: "Agent response or action output payload" },
        { field: "error", description: "Error description if execution failed" },
      ],
      configFields: [
        {
          id: "action",
          label: "Action Name",
          type: "text",
          placeholder: "e.g. EXECUTE_ONCHAIN_KEEPERHUB or REBALANCE_DEFI",
          configKey: "action",
          required: true,
          helpText: "The action handler registered in the ElizaOS runtime.",
        },
        {
          id: "payload",
          label: "Payload JSON",
          type: "text",
          placeholder: '{"protocol": "aave-v3", "minHealthFactor": 1.5}',
          configKey: "payload",
          required: false,
          helpText: "JSON payload containing parameters for the agent.",
        },
      ],
    },
  ],
};

registerIntegration(elizaosPlugin);

export default elizaosPlugin;
