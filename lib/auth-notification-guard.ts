// Suppresses signup notifications (Discord webhook, MailerLite subscribe)
// for users who are not actually freshly created. The notification call
// sites live in better-auth hooks that, under some flows, can receive a
// User object for a row that already existed long before the hook ran -
// `afterEmailVerification` for instance fires when an `/email-otp/verify-email`
// completes against an existing user, not only on a brand-new signup
// (see KEEP-634 for the underlying flow defect). Treat anything older
// than the window as a re-event rather than a new signup.
//
// 24 hour window: the legitimate-signup verification flows that surface
// stale createdAt timestamps are the slow ones - an unverified email +
// password user who started signup, abandoned the tab, came back later
// and finally entered the OTP, or a user clicking a 1-hour-TTL
// verification link near its expiry. A 1-hour ceiling collides with both
// (Better Auth's default link TTL is 3600s, so a click at 59m59s with
// any network skew lands just past a 1h cutoff). 24h comfortably absorbs
// both flows plus clock skew between app pods, while still suppressing
// re-verification of week-old users (the actual bug class).
//
// `<=` rather than `<` so the exact boundary tick is treated as fresh -
// avoids a one-millisecond hole at the upper edge.

export const NEW_SIGNUP_NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isFreshSignup(user: { createdAt?: Date | null }): boolean {
  if (!user.createdAt) {
    return false;
  }
  const createdAtMs = user.createdAt.getTime();
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return Date.now() - createdAtMs <= NEW_SIGNUP_NOTIFICATION_WINDOW_MS;
}
