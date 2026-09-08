/**
 * Per-(user, action) sliding-window counter for requireDualFactor.
 *
 * Each POST to a dual-factor-guarded endpoint registers an attempt
 * for the same (userId, action) key, regardless of whether codes are
 * present. That covers both attack surfaces:
 *
 *   - Empty-body floods: attacker submits the dual-factor endpoint
 *     with no codes to force fresh email OTPs at the victim's inbox.
 *   - Brute-force guesses: attacker has stolen one factor and tries
 *     to guess the other across a live verifications row.
 *
 * In-memory per pod, matching the pattern in lib/mcp/rate-limit.ts.
 * In a multi-replica deployment each pod tracks its own window;
 * effective limit is LIMIT_PER_WINDOW * num_replicas. Migrate to
 * Redis when replica count starts to matter.
 *
 * On a successful dual-factor verify the caller invokes `resetDualFactor`
 * to wipe the counter; this prevents a legitimately-confused user
 * from running out of room after a few typos before they finally hit
 * the right codes.
 */

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LIMIT_PER_WINDOW = 10;

const attemptLog = new Map<string, number[]>();

const keyFor = (userId: string, action: string): string =>
  `${userId}:${action}`;

export type DualFactorRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

export function checkDualFactorRateLimit(
  userId: string,
  action: string
): DualFactorRateLimitResult {
  const key = keyFor(userId, action);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = attemptLog.get(key);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= LIMIT_PER_WINDOW) {
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  recent.push(now);
  attemptLog.set(key, recent);
  return { allowed: true };
}

export function resetDualFactor(userId: string, action: string): void {
  attemptLog.delete(keyFor(userId, action));
}

// Test-only: wipe all tracked windows.
export function resetDualFactorRateLimitState(): void {
  attemptLog.clear();
}
