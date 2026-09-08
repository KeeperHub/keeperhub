import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isFreshSignup,
  NEW_SIGNUP_NOTIFICATION_WINDOW_MS,
} from "@/lib/auth-notification-guard";

// Pin "now" so windows are deterministic. NOW is also the moment in time
// when the production false-positive on 2026-05-25 14:12 UTC fired - the
// "four-week-old re-verification" regression below is anchored to this.
const NOW = new Date("2026-05-25T14:12:00Z");

describe("isFreshSignup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for a user created seconds ago", () => {
    const createdAt = new Date(NOW.getTime() - 30 * 1000);
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns true at WINDOW - 1ms (just inside the boundary)", () => {
    const createdAt = new Date(
      NOW.getTime() - (NEW_SIGNUP_NOTIFICATION_WINDOW_MS - 1)
    );
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns true at exactly WINDOW (inclusive boundary)", () => {
    const createdAt = new Date(
      NOW.getTime() - NEW_SIGNUP_NOTIFICATION_WINDOW_MS
    );
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns false at WINDOW + 1ms (just past the boundary)", () => {
    const createdAt = new Date(
      NOW.getTime() - (NEW_SIGNUP_NOTIFICATION_WINDOW_MS + 1)
    );
    expect(isFreshSignup({ createdAt })).toBe(false);
  });

  it("covers the Better Auth 1-hour verification-link TTL with margin", () => {
    // Default emailVerification.expiresIn is 3600s. A user clicking the
    // link just past 1h (e.g. due to network/processing skew) must still
    // fire the signup notification.
    const createdAt = new Date(NOW.getTime() - 60 * 60 * 1000 - 5000);
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns false for a 28-day-old user (the production regression)", () => {
    // 2026-05-25 14:12 UTC: a POST /sign-up/email landed for an email that
    // already had an OAuth-only account from 2026-04-27 (~28 days prior).
    // Better Auth sent an OTP to the existing inbox, the actor entered it,
    // afterEmailVerification fired for the existing user, and
    // notifyDiscordSignup posted a false-positive "New signup" alert. The
    // guard must suppress that notification.
    const createdAt = new Date("2026-04-27T21:02:58.926Z");
    expect(isFreshSignup({ createdAt })).toBe(false);
    // Sanity: the delta is well past the window (and well past the OTP
    // resend / verification-link flows the window is sized for).
    expect(NOW.getTime() - createdAt.getTime()).toBeGreaterThan(
      NEW_SIGNUP_NOTIFICATION_WINDOW_MS
    );
  });

  it("returns true for a future-dated createdAt (NTP skew safety)", () => {
    // Cross-pod clock skew can put a freshly-inserted row a few seconds
    // ahead of the verifying pod's clock. The guard must not flip on
    // skew-induced future timestamps.
    const createdAt = new Date(NOW.getTime() + 2000);
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns false when createdAt is missing", () => {
    expect(isFreshSignup({})).toBe(false);
  });

  it("returns false when createdAt is null", () => {
    expect(isFreshSignup({ createdAt: null })).toBe(false);
  });

  it("returns false when createdAt is an Invalid Date", () => {
    expect(isFreshSignup({ createdAt: new Date("not a real date") })).toBe(
      false
    );
  });

  it("returns false at epoch zero (would be ~56 years stale)", () => {
    expect(isFreshSignup({ createdAt: new Date(0) })).toBe(false);
  });
});
