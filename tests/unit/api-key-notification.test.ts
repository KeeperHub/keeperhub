import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendApiKeyChangeEmail, mockGetDeliverableEmail } = vi.hoisted(
  () => ({
    mockSendApiKeyChangeEmail: vi.fn(),
    mockGetDeliverableEmail: vi.fn(),
  })
);

vi.mock("@/lib/email", () => ({
  sendApiKeyChangeEmail: mockSendApiKeyChangeEmail,
}));

vi.mock("@/lib/security/notification-email", () => ({
  getDeliverableEmail: mockGetDeliverableEmail,
}));

import { notifyApiKeyChange } from "@/lib/security/api-key-notification";

const baseEvent = {
  userId: "user_1",
  loginEmail: "owner@example.com",
  action: "created" as const,
  tokenName: "CI deploy key",
  keyPrefix: "wfb_abc123",
  when: new Date("2026-06-03T00:00:00.000Z"),
};

const expectedEmail = {
  email: "owner@example.com",
  action: "created" as const,
  tokenName: "CI deploy key",
  keyPrefix: "wfb_abc123",
  when: new Date("2026-06-03T00:00:00.000Z"),
};

beforeEach(() => {
  mockSendApiKeyChangeEmail.mockReset();
  mockSendApiKeyChangeEmail.mockResolvedValue(true);
  mockGetDeliverableEmail.mockReset();
  mockGetDeliverableEmail.mockResolvedValue("owner@example.com");
});

describe("notifyApiKeyChange", () => {
  it("forwards the create event to the email helper", async () => {
    notifyApiKeyChange(baseEvent);

    await vi.waitFor(() =>
      expect(mockSendApiKeyChangeEmail).toHaveBeenCalledTimes(1)
    );
    expect(mockSendApiKeyChangeEmail).toHaveBeenCalledWith(expectedEmail);
  });

  it("forwards the revoke event to the email helper", async () => {
    notifyApiKeyChange({ ...baseEvent, action: "revoked" });

    await vi.waitFor(() =>
      expect(mockSendApiKeyChangeEmail).toHaveBeenCalledTimes(1)
    );
    expect(mockSendApiKeyChangeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revoked", email: "owner@example.com" })
    );
  });

  it("delivers to the enrolled step-up email for a wallet user", async () => {
    mockGetDeliverableEmail.mockResolvedValue("verified@example.com");

    notifyApiKeyChange({
      ...baseEvent,
      loginEmail: "0xabc@wallet.keeperhub.com",
    });

    await vi.waitFor(() =>
      expect(mockSendApiKeyChangeEmail).toHaveBeenCalledTimes(1)
    );
    expect(mockSendApiKeyChangeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "verified@example.com" })
    );
  });

  it("skips entirely when there is no deliverable email", async () => {
    mockGetDeliverableEmail.mockResolvedValue(null);

    notifyApiKeyChange(baseEvent);

    await vi.waitFor(() =>
      expect(mockGetDeliverableEmail).toHaveBeenCalledTimes(1)
    );
    // Use a macrotask to flush all pending microtasks before the negative assertion.
    await new Promise((res) => setTimeout(res, 0));
    expect(mockSendApiKeyChangeEmail).not.toHaveBeenCalled();
  });

  it("swallows a delivery rejection without throwing", async () => {
    mockSendApiKeyChangeEmail.mockRejectedValue(new Error("SendGrid down"));
    expect(() => notifyApiKeyChange(baseEvent)).not.toThrow();
    await vi.waitFor(() =>
      expect(mockSendApiKeyChangeEmail).toHaveBeenCalledTimes(1)
    );
  });
});
