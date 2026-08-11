import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { DiscordIcon } from "./icon";

const discordPlugin: IntegrationPlugin = {
  type: "discord",
  egress: "fixed-host",
  label: "Discord",
  description: "Send messages to Discord channels via webhooks",

  icon: DiscordIcon,

  // Webhook URL is stored in the integration for centralized management
  formFields: [
    {
      id: "webhookUrl",
      label: "Webhook URL",
      type: "password",
      placeholder: "https://discord.com/api/webhooks/...",
      configKey: "webhookUrl",
      envVar: "webhookUrl",
      helpText:
        "Discord webhook URL for this channel. This URL will be used by all actions using this integration.",
      helpLink: {
        text: "Learn how to create webhooks",
        url: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
      },
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testDiscord } = await import("./test");
      return testDiscord;
    },
  },

  actions: [
    {
      slug: "send-message",
      label: "Send Discord Message",
      description: "Send a message to a Discord channel via webhook",
      category: "Discord",
      stepFunction: "sendDiscordMessageStep",
      stepImportPath: "send-message",
      outputFields: [
        { field: "success", description: "Whether the message was sent" },
        { field: "messageId", description: "Discord message ID" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "discordMessage",
          label: "Message",
          type: "template-textarea",
          placeholder:
            "Your message. Use {{NodeName.field}} to insert data from previous nodes.",
          rows: 4,
          example: "Hello from my workflow!",
          required: true,
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(discordPlugin);

export default discordPlugin;
