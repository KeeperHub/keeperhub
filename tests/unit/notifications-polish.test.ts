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

function discordBody() {
  const [, options] = safeFetch.mock.calls[0] as [string, { body?: string }];
  return JSON.parse(options.body as string);
}

function telegramBodyParams() {
  const [, options] = safeFetch.mock.calls[0] as [string, { body?: string }];
  return new URLSearchParams(options.body as string);
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
    mockFetchCredentials.mockResolvedValue({ webhookUrl: WEBHOOK });
    safeFetch.mockResolvedValue({ ok: true, status: 204 });

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
      username: "KeeperHub Alerts",
      avatarUrl: "https://example.com/avatar.png",
    } as never);

    const body = discordBody();
    expect(body.content).toBe("hello");
    expect(body.username).toBe("KeeperHub Alerts");
    expect(body.avatar_url).toBe("https://example.com/avatar.png");
    expect(body.embeds).toBeUndefined();
  });

  it("discord sends a red embed when title + color are set", async () => {
    mockFetchCredentials.mockResolvedValue({ webhookUrl: WEBHOOK });
    safeFetch.mockResolvedValue({ ok: true, status: 204 });

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "Balance low",
      embedTitle: "Critical",
      embedColor: "red",
    } as never);

    const body = discordBody();
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe("Critical");
    expect(body.embeds[0].description).toBe("Balance low");
    expect(body.embeds[0].color).toBe(15_158_332);
  });

  it("discord sends no embeds by default (backward compatible)", async () => {
    mockFetchCredentials.mockResolvedValue({ webhookUrl: WEBHOOK });
    safeFetch.mockResolvedValue({ ok: true, status: 204 });

    await sendDiscordMessageStep({
      integrationId: "int-1",
      discordMessage: "hello",
    } as never);

    const body = discordBody();
    expect(body).toEqual({ content: "hello" });
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
});
