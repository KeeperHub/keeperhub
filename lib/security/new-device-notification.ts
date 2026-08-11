import { sendNewDeviceEmail } from "@/lib/email";
import { getRedis } from "@/lib/redis";
import { newDeviceNotifyClaimKey } from "@/lib/redis-keys";
import { describeUserAgentLabel } from "@/lib/security/device-label";
import { logIpVerify } from "@/lib/security/login-risk";

/**
 * Dedup + delivery for the courtesy email sent when a device not in
 * user_trusted_devices signs in. Redis is the sole dedup: `SET NX` is atomic,
 * so concurrent sign-ins on the same device yield exactly one send across the
 * fleet. Fire-and-forget; never blocks the sign-in.
 */

// Suppress re-sends for a week per (user, device).
export const NEW_DEVICE_NOTIFY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * True when this process should send for (userId, deviceId): the Redis
 * `SET NX` won, so this is the first claim on the device within the TTL.
 * Returns false when another caller already claimed it, when no Redis is
 * configured, or on a Redis error -- with no dedup authority we skip the
 * courtesy email rather than risk one per request.
 */
export async function claimNewDeviceNotification(
  userId: string,
  deviceId: string
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    return false;
  }
  try {
    const result = await redis.set(
      newDeviceNotifyClaimKey(userId, deviceId),
      "1",
      "EX",
      NEW_DEVICE_NOTIFY_TTL_SECONDS,
      "NX"
    );
    return result === "OK";
  } catch (err) {
    logIpVerify("device-notify-claim-error", {
      userId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}

export type NewDeviceNotification = {
  userId: string;
  email: string;
  deviceId: string;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
};

async function deliver(notification: NewDeviceNotification): Promise<void> {
  const { userId, email, deviceId, ip, country, userAgent } = notification;
  try {
    if (!(await claimNewDeviceNotification(userId, deviceId))) {
      return;
    }
    await sendNewDeviceEmail({
      email,
      ip,
      country,
      device: describeUserAgentLabel(userAgent),
      when: new Date(),
    });
  } catch {
    // best-effort; underlying failures are logged in the helpers
  }
}

/**
 * Notify the account owner about a new device, deduped fleet-wide by the Redis
 * claim in deliver(). Non-blocking; the sign-in must never wait on Redis or
 * SendGrid.
 */
export function maybeNotifyNewDevice(
  notification: NewDeviceNotification
): void {
  const { userId, deviceId } = notification;
  if (!(userId && deviceId)) {
    return;
  }
  deliver(notification).catch(() => {
    // deliver() already swallows; this is the floating-promise boundary
  });
}
