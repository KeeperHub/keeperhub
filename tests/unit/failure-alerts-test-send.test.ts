import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

const members = Array.from({ length: 31 }, (_, i) => ({
  userId: `u${i}`,
  role: i === 0 ? "owner" : "member",
  email: `m${i}@x.dev`,
  name: null,
  deliverable: `m${i}@x.dev`,
}));
vi.mock("@/lib/notifications/org-recipients", () => ({
  loadOrgMembers: async () => members,
  reachableEmails: (list: { deliverable: string | null }[]) => [
    ...new Set(list.flatMap((m) => (m.deliverable ? [m.deliverable] : []))),
  ],
}));

const orgRow = { limit: async () => [{ name: "Acme" }] };
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => orgRow }) }) },
}));

const sendEmailMessage = vi.fn(async () => ({
  ok: true,
  retryable: false,
  message: "",
}));
vi.mock("@/lib/notifications/failure-alerts/senders", () => ({
  sendEmailMessage,
  sendChannelMessage: vi.fn(),
  checkChannelSilently: vi.fn(),
}));
vi.mock("@/lib/notifications/failure-alerts/messages", () => ({
  appBaseUrl: () => "https://app.test",
  renderMessage: () => ({ subject: "s", text: "t", html: "h" }),
}));

const { sendTest } = await import(
  "@/lib/notifications/failure-alerts/test-send"
);

function emailTest(userId: string, organizationId: string, ids: string[]) {
  return sendTest({
    organizationId,
    userId,
    request: { channel: "email", to: "recipients", recipientUserIds: ids },
  });
}

describe("email tests count each recipient against the daily limit", () => {
  beforeEach(() => {
    sendEmailMessage.mockClear();
  });

  it("refuses a test that would email more people than the day allows", async () => {
    await expect(
      emailTest(
        "sender-a",
        "org-wide",
        members.map((m) => m.userId)
      )
    ).rejects.toMatchObject({ status: 429 });
    expect(sendEmailMessage).not.toHaveBeenCalled();
  });

  it("spends the day's sends by recipients, not by tests", async () => {
    const three = ["u1", "u2", "u3"];
    // 30 sends a day: ten tests to three people use them all.
    for (let i = 0; i < 10; i++) {
      await emailTest(`sender-${i}`, "org-three", three);
    }
    expect(sendEmailMessage).toHaveBeenCalledTimes(30);
    await expect(
      emailTest("sender-last", "org-three", three)
    ).rejects.toMatchObject({ status: 429 });
  });
});
