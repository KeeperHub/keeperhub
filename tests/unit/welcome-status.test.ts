// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isContinueAsGuest,
  markContinueAsGuest,
  markOnboardingComplete,
} from "@/lib/welcome-status";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("continue-as-guest flag", () => {
  it("defaults to false and flips once marked", () => {
    expect(isContinueAsGuest()).toBe(false);
    markContinueAsGuest();
    expect(isContinueAsGuest()).toBe(true);
  });
});

describe("markOnboardingComplete", () => {
  it("POSTs to the completion endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await markOnboardingComplete();

    expect(fetchMock).toHaveBeenCalledWith("/api/user/onboarding/complete", {
      method: "POST",
    });
  });

  it("resolves even when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(markOnboardingComplete()).resolves.toBeUndefined();
  });
});
