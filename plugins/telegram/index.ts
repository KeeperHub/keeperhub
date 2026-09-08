import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { TelegramIcon } from "./icon";

const telegramPlugin: IntegrationPlugin = {
  type: "telegram",
  egress: "fixed-host",
  label: "Telegram",
  description: "Send messages to Telegram chats via bot API",

  icon: TelegramIcon,

  formFields: [
    {
      id: "botToken",
      label: "Bot Token",
      type: "password",
      placeholder: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      configKey: "botToken",
      envVar: "TELEGRAM_BOT_TOKEN",
      helpText:
        "Telegram bot token. This token will be used by all actions using this integration.",
      helpLink: {
        text: "Learn how to create a bot",
        url: "https://core.telegram.org/bots/tutorial",
      },
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testTelegram } = await import("./test");
      return testTelegram;
    },
  },

  actions: [
    {
      slug: "send-message",
      label: "Send Telegram Message",
      description: "Send a text message to a Telegram chat",
      category: "Telegram",
      stepFunction: "sendTelegramMessageStep",
      stepImportPath: "send-message",
      outputFields: [
        { field: "success", description: "Whether the message was sent" },
        { field: "messageId", description: "Telegram message ID" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "chatId",
          label: "Chat ID",
          type: "template-input",
          placeholder:
            "Enter chat ID or use {{NodeName.field}}. Can be numeric or @username",
          example: "123456789 or @channelusername",
          required: true,
        },
        {
          key: "message",
          label: "Message",
          type: "template-textarea",
          placeholder:
            "Your message. Use {{NodeName.field}} to insert data from previous nodes. Note: If using MarkdownV2, special characters (., -, _, *, [, ], (, ), ~, `, >, #, +, =, |, {, }, !) must be escaped with \\.",
          rows: 4,
          example: "Hello from my workflow!",
          required: true,
        },
        {
          key: "parseMode",
          label: "Parse Mode",
          type: "select",
          options: [
            { value: "none", label: "None (Plain Text)" },
            {
              value: "MarkdownV2",
              label: "MarkdownV2 (requires escaping special chars)",
            },
          ],
          defaultValue: "none",
          placeholder: "Select parse mode",
          example: "none",
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(telegramPlugin);

export default telegramPlugin;
