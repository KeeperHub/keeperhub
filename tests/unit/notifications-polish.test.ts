import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    VALIDATION: "validation",
    EXTERNAL_SERVICE: "external_service",
    NETWORK_RPC: "network_rpc",
  },
  logUserError: vi.fn(),
}));

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { sendDiscordMessageStep } from "@/plugins/discord/steps/send-message";
import slackPlugin from "@/plugins/slack/index";
import { sendTelegramMessageStep } from "@/plugins/telegram/steps/send-message";

const WEBHOOK = "https://discord.com/api/webhooks/123/abc";
const RED = 15_158_332;

function discordBody() {
  const [, options] = safeFetch.mock.calls[0] as [string, { body?: string }];
  return JSON.parse(options.body as string);
}

function telegramBodyParams() {
  const [, options] = safeFetch.mock.calls[0] as [string, { body?: string }];
  return new URLSearchParams(options.body as string);
}

function discordOk() {
  mockFetchCredentials.mockResolvedValue({ webhookUrl: WEBHOOK });
  safeFetch.mockResolvedValue({ ok: true, status: 204 });
}

describe("notifications polish", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
  });

  it("slack channel field supports {{variables}}", () => {
    const action = slackPlugin.actions.find((a) => a.slug === "send-message");
    const channel = action?.configFields.find(
      (f) => !("fields" in f) && f.key === "slackChannel"
    ) as { type: string } | undefined;
    expect(channel?.type).toBe("template-input");
  });

  it("discord passes username and avatar through", async () => {
    discordOk();

    const result = await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
      username: "KeeperHub Alerts",
      avatarUrl: "https://example.com/avatar.png",
    } as never);

    expect(result).toEqual({ success: true, messageId: "sent" });
    expect(discordBody()).toEqual({
      content: "hello",
      username: "KeeperHub Alerts",
      avatar_url: "https://example.com/avatar.png",
    });
  });

  it("discord moves the message into the embed instead of duplicating it", async () => {
    discordOk();

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "Balance low",
      embedTitle: "Critical",
      embedColor: "red",
    } as never);

    expect(discordBody()).toEqual({
      embeds: [{ title: "Critical", description: "Balance low", color: RED }],
    });
  });

  it("discord sends an embed when only a colour is set", async () => {
    discordOk();

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "Balance low",
      embedColor: "green",
    } as never);

    expect(discordBody()).toEqual({
      embeds: [{ description: "Balance low", color: 3_066_993 }],
    });
  });

  it("discord sends no embeds by default (backward compatible)", async () => {
    discordOk();

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
    } as never);

    expect(discordBody()).toEqual({ content: "hello" });
  });

  it("discord drops an unparseable avatar URL and still sends", async () => {
    discordOk();

    const result = await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
      avatarUrl: "not a url",
    } as never);

    expect(result).toEqual({ success: true, messageId: "sent" });
    expect(discordBody()).toEqual({ content: "hello" });
  });

  it("discord drops a non-https avatar URL and still sends", async () => {
    discordOk();

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
      avatarUrl: "http://example.com/avatar.png",
    } as never);

    expect(discordBody()).toEqual({ content: "hello" });
  });

  it("discord drops a username Discord would reject and still sends", async () => {
    discordOk();

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
      username: "Discord Support",
    } as never);

    expect(discordBody()).toEqual({ content: "hello" });
  });

  it("discord ignores an unrecognised embed colour", async () => {
    discordOk();

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
      embedColor: "constructor",
    } as never);

    expect(discordBody()).toEqual({ content: "hello" });
  });

  it("discord keeps the embed when the colour is unrecognised but a title is set", async () => {
    discordOk();

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
      embedTitle: "Heads up",
      embedColor: "puce",
    } as never);

    expect(discordBody()).toEqual({
      embeds: [{ title: "Heads up", description: "hello" }],
    });
  });

  it("discord truncates username to 80, title to 256 and description to 4096", async () => {
    discordOk();

    const longMessage = "m".repeat(5000);

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: longMessage,
      username: "u".repeat(120),
      embedTitle: "t".repeat(400),
      embedColor: "red",
    } as never);

    expect(discordBody()).toEqual({
      username: "u".repeat(80),
      embeds: [
        {
          title: "t".repeat(256),
          description: "m".repeat(4096),
          color: RED,
        },
      ],
    });
  });

  it("telegram sends HTML parse mode and disables previews", async () => {
    mockFetchCredentials.mockResolvedValue({
      TELEGRAM_BOT_TOKEN: "bot-token",
    });
    safeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });

    await sendTelegramMessageStep({
      integrationId: "int-1",
      chatId: "123",
      message: "<b>Balance low</b>",
      parseMode: "HTML",
      disablePreview: "true",
    } as never);

    const params = telegramBodyParams();
    expect(params.get("parse_mode")).toBe("HTML");
    expect(params.get("disable_web_page_preview")).toBe("true");
    expect(params.get("text")).toBe("<b>Balance low</b>");
  });

  it("telegram omits parse_mode for plain text and keeps previews on", async () => {
    mockFetchCredentials.mockResolvedValue({
      TELEGRAM_BOT_TOKEN: "bot-token",
    });
    safeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 2 } }),
    });

    await sendTelegramMessageStep({
      integrationId: "int-1",
      chatId: "123",
      message: "hello",
      parseMode: "none",
      disablePreview: "false",
    } as never);

    const params = telegramBodyParams();
    expect(params.get("parse_mode")).toBeNull();
    expect(params.get("disable_web_page_preview")).toBeNull();
  });

  it("telegram explains an HTML parse failure", async () => {
    mockFetchCredentials.mockResolvedValue({
      TELEGRAM_BOT_TOKEN: "bot-token",
    });
    safeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        description: "Bad Request: can't parse entities: unsupported start tag",
      }),
    });

    const result = (await sendTelegramMessageStep({
      integrationId: "int-1",
      chatId: "123",
      message: "<marquee>hi</marquee>",
      parseMode: "HTML",
    } as never)) as { success: false; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("When using HTML");
    expect(result.error).toContain("&amp;");
  });
});
