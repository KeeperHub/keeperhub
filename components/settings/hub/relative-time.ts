const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function span(ms: number): string {
  if (ms < HOUR) {
    return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  }
  if (ms < DAY) {
    return `${Math.round(ms / HOUR)}h`;
  }
  return `${Math.round(ms / DAY)}d`;
}

/** "3d ago", or "just now" for anything under a minute. */
export function timeAgo(value: Date | string): string {
  const diff = Date.now() - new Date(value).getTime();
  return diff < MINUTE ? "just now" : `${span(diff)} ago`;
}

/** "in 4d", or "expired" once the moment has passed. */
export function timeUntil(value: Date | string): string {
  const diff = new Date(value).getTime() - Date.now();
  return diff <= 0 ? "expired" : `in ${span(diff)}`;
}

/** "Sent 2d ago · Expires in 5d", or "· Expired" once it has lapsed. */
export function invitationTiming(
  createdAt: Date | string | undefined,
  expiresAt: Date | string | undefined
): string {
  const parts: string[] = [];
  if (createdAt) {
    parts.push(`Sent ${timeAgo(createdAt)}`);
  }
  if (expiresAt) {
    const lapsed = new Date(expiresAt).getTime() <= Date.now();
    parts.push(lapsed ? "Expired" : `Expires ${timeUntil(expiresAt)}`);
  }
  return parts.join(" · ");
}
