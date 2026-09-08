import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userTrustedDevices } from "@/lib/db/schema";
import {
  buildDeviceSetCookie,
  decodeDeviceCookie,
  encodeDeviceCookie,
  newDeviceId,
  readDeviceCookie,
} from "@/lib/device-cookie";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveClientIpFromHeaders } from "@/lib/security/login-risk";
import { maybeNotifyNewDevice } from "@/lib/security/new-device-notification";

/**
 * Device-trust bookkeeping keyed on the random id carried in the signed
 * `kh_device_id` cookie. A device not already in user_trusted_devices is
 * allowed through (full MFA already ran at sign-in) but the account owner is
 * emailed -- unless it is the account's first-ever device, which is the signup
 * device and not worth alarming.
 */

export type DeviceTrust = {
  known: boolean;
  isFirstDevice: boolean;
};

/**
 * Look up (user, device). `known` is true when the device id is already
 * recorded for the user. `isFirstDevice` is true when the user has no device
 * rows at all, which suppresses the warning email for the signup device.
 */
export async function assessDeviceTrust(
  userId: string,
  deviceId: string
): Promise<DeviceTrust> {
  const [hit] = await db
    .select({ id: userTrustedDevices.id })
    .from(userTrustedDevices)
    .where(
      and(
        eq(userTrustedDevices.userId, userId),
        eq(userTrustedDevices.deviceId, deviceId)
      )
    )
    .limit(1);
  if (hit) {
    return { known: true, isFirstDevice: false };
  }
  const [anyDevice] = await db
    .select({ id: userTrustedDevices.id })
    .from(userTrustedDevices)
    .where(eq(userTrustedDevices.userId, userId))
    .limit(1);
  return { known: false, isFirstDevice: !anyDevice };
}

/**
 * Idempotently record a device for a user. The unique (user_id, device_id)
 * constraint makes the upsert safe to repeat: a known device bumps
 * last_seen_at and refreshes the user-agent label. Best-effort; a failure is
 * logged and swallowed so device bookkeeping never blocks the sign-in.
 */
export async function recordTrustedDevice(
  userId: string,
  deviceId: string,
  userAgent: string | null
): Promise<void> {
  try {
    await db
      .insert(userTrustedDevices)
      .values({ userId, deviceId, userAgent })
      .onConflictDoUpdate({
        target: [userTrustedDevices.userId, userTrustedDevices.deviceId],
        set: { lastSeenAt: new Date(), userAgent },
      });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[device-trust] failed to upsert trusted device",
      err,
      { user_id: userId }
    );
  }
}

type ResolveSigninDeviceArgs = {
  userId: string;
  email: string;
  country: string | null;
  request: Request;
  // When false, a new device is recorded but the warning email is suppressed.
  // Used by the proxy bridge to silently adopt browsers whose sessions
  // predate device tracking (no surprise email for an already-active session).
  notifyOnNew?: boolean;
};

/**
 * Shared entrypoint the session-minting routes call after a session is
 * created. Reads the device cookie (minting a fresh id when absent or
 * tampered), emails the owner when the device is new and not their first
 * (unless notifyOnNew is false), records the device, and returns the
 * `Set-Cookie` string for the caller to append so the browser is recognised
 * next time. Returns null when the server secret is missing (the cookie
 * cannot be signed); device tracking is then skipped without affecting the
 * sign-in.
 */
export async function resolveSigninDevice(
  args: ResolveSigninDeviceArgs
): Promise<string | null> {
  const { userId, email, country, request, notifyOnNew = true } = args;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    return null;
  }
  const userAgent = request.headers.get("user-agent");
  const raw = readDeviceCookie(request.headers);
  const decoded = raw ? decodeDeviceCookie(raw, secret) : null;
  const deviceId = decoded?.ok ? decoded.payload.deviceId : newDeviceId();

  const { known, isFirstDevice } = await assessDeviceTrust(userId, deviceId);
  if (notifyOnNew && !(known || isFirstDevice)) {
    maybeNotifyNewDevice({
      userId,
      email,
      deviceId,
      ip: resolveClientIpFromHeaders(request.headers),
      country,
      userAgent,
    });
  }
  await recordTrustedDevice(userId, deviceId, userAgent);
  return buildDeviceSetCookie(encodeDeviceCookie(deviceId, secret));
}
