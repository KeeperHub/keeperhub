import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import OpenClawIcon from "./icon";

/**
 * OpenClaw agent hooks.
 *
 * OpenClaw exposes one stable ingress for handing work to an agent turn:
 * `POST /hooks/agent`, authenticated by a dedicated hook token. A workflow
 * can already reach it through the generic Webhook action, but that path puts
 * a long-lived token into free-form action headers, where it travels with a
 * copied workflow, and it leaves every contract rule to the author:
 *
 *   - the token belongs in `Authorization: Bearer` or `x-openclaw-token`, and
 *     a `token` query parameter is rejected even next to a valid header;
 *   - the hook token should be distinct from the Gateway shared secret
 *     (`openclaw security audit` reports a critical finding otherwise);
 *   - a `200` proves admission, not a model result or a delivery;
 *   - a partial direct destination fails with 400 while delivery is enabled;
 *   - a retry without the same idempotency key can admit a second turn.
 *
 * This plugin encodes those once instead: credentials live on the
 * integration, the path is fixed, `deliver` is pinned off, and the result
 * says `admitted: true` rather than implying completion.
 */
const openClawPlugin: IntegrationPlugin = {
  type: "openclaw",
  // The base URL is supplied per integration, so requests go to a
  // user-chosen destination rather than a fixed host.
  egress: "user-destination",
  label: "OpenClaw",
  description:
    "Hand a workflow result to an OpenClaw agent turn through the instance's agent hook",

  icon: OpenClawIcon,

  formFields: [
    {
      id: "openclawBaseUrl",
      label: "Instance URL",
      type: "url",
      placeholder: "https://claw.example.com",
      configKey: "baseUrl",
      envVar: "OPENCLAW_BASE_URL",
      helpText:
        "Public base URL of the OpenClaw instance. The action appends /hooks/agent to it.",
    },
    {
      id: "openclawHookToken",
      label: "Hook Token",
      type: "password",
      placeholder: "Dedicated hook token",
      configKey: "apiKey",
      envVar: "OPENCLAW_HOOK_TOKEN",
      helpText:
        "The instance's dedicated hook token. Keep it distinct from the Gateway shared secret - `openclaw security audit` flags a shared value as critical.",
      helpLink: {
        text: "docs.openclaw.ai/gateway/config-hooks",
        url: "https://docs.openclaw.ai/gateway/config-hooks",
      },
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testOpenClawConnection } = await import("./test");
      return async (credentials: Record<string, string>) => {
        const result = await testOpenClawConnection({
          OPENCLAW_BASE_URL: credentials.OPENCLAW_BASE_URL,
          OPENCLAW_HOOK_TOKEN: credentials.OPENCLAW_HOOK_TOKEN,
        });
        return {
          success: result.status === "success",
          error: result.status === "error" ? result.message : undefined,
        };
      };
    },
  },

  actions: [
    {
      slug: "trigger-agent",
      label: "Trigger Agent",
      description:
        "Admit an agent turn on an OpenClaw instance. The result confirms admission (runId), not completion",
      category: "OpenClaw",
      stepFunction: "triggerAgentStep",
      stepImportPath: "trigger-agent",
      configFields: [
        {
          key: "message",
          label: "Message",
          type: "template-textarea",
          placeholder: "Alert: {{NodeName.eventName}} with {{NodeName.amount}}",
          example: "Summarise this execution result and notify me if it looks wrong.",
          required: true,
        },
        {
          key: "agentId",
          label: "Agent ID",
          type: "template-input",
          placeholder: "main",
          example: "main",
        },
        {
          key: "name",
          label: "Hook Name",
          type: "template-input",
          placeholder: "Hook",
          example: "treasury-monitor",
        },
        {
          key: "timeoutSeconds",
          label: "Timeout (seconds)",
          type: "number",
          placeholder: "300",
        },
      ],
    },
  ],
};

registerIntegration(openClawPlugin);

export default openClawPlugin;
