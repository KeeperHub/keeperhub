import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
const { mockFetchCredentials } = vi.hoisted(() => ({
  mockFetchCredentials: vi.fn(),
}));
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

const { sendBackupNotification } = await import(
  "@/lib/notifications/backup-channel"
);

const variants = [
  [
    "Failing: ",
    { user: "<!channel> @everyone" },
    " ",
    { code: "x".repeat(5000) },
  ],
  ["Failing: ", { user: "<!channel> @everyone" }],
];

async function bodyFor(
  credentials: Record<string, string>,
  message: typeof variants
): Promise<Record<string, unknown>> {
  mockFetchCredentials.mockResolvedValue(credentials);
  const outcome = await sendBackupNotification({
    integrationId: "int-1",
    destination: "#ops",
    plugin: "failure-alerts",
    message,
  });
  expect(outcome.delivered).toBe(true);
  const [, init] = safeFetch.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("backup channel formatting", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    safeFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
  });

  it("sends Discord no mentions and within 2000 characters", async () => {
    const body = await bodyFor(
      { webhookUrl: "https://discord.com/api/webhooks/1/abc" },
      variants
    );
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(String(body.content)).toBe("Failing: \\<!channel\\> \\@everyone");
  });

  it("escapes Slack text", async () => {
    const body = await bodyFor({ SLACK_API_KEY: "xoxb-1" }, [
      ["a ", { user: "<!here> & b" }],
    ]);
    expect(body.text).toBe("a &lt;!here&gt; &amp; b");
  });

  it("sends Telegram as HTML within 4096 characters", async () => {
    const body = await bodyFor({ TELEGRAM_BOT_TOKEN: "1:abc" }, variants);
    expect(body.parse_mode).toBe("HTML");
    expect(String(body.text).length).toBeLessThanOrEqual(4096);
    expect(String(body.text)).toBe("Failing: &lt;!channel&gt; @everyone");
  });
});
