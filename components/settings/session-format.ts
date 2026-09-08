import {
  Laptop,
  type LucideIcon,
  Monitor,
  Smartphone,
  Tablet,
} from "lucide-react";

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/** Human-friendly "3 minutes ago" / "in 2 days" for an ISO timestamp. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "Unknown";
  }
  const deltaSeconds = Math.round((then - Date.now()) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  if (absSeconds < 60) {
    return RELATIVE_TIME.format(deltaSeconds, "second");
  }
  if (absSeconds < 3600) {
    return RELATIVE_TIME.format(Math.round(deltaSeconds / 60), "minute");
  }
  if (absSeconds < 86_400) {
    return RELATIVE_TIME.format(Math.round(deltaSeconds / 3600), "hour");
  }
  return RELATIVE_TIME.format(Math.round(deltaSeconds / 86_400), "day");
}

/**
 * Best-effort browser + OS label and a matching device icon parsed from a
 * user-agent string. Shared by the self-service active-sessions panel and
 * the org-admin per-member sessions view so both describe devices the
 * same way.
 */
const MOBILE = /iphone|android.*mobile/;
const TABLET = /ipad|android(?!.*mobile)/;

// Ordered: Edge and Chrome both claim to be Safari, and Edge claims Chrome.
const BROWSERS: readonly [needle: string, name: string][] = [
  ["firefox", "Firefox"],
  ["edg/", "Edge"],
  ["chrome", "Chrome"],
  ["safari", "Safari"],
];

const OPERATING_SYSTEMS: readonly [needle: string, name: string][] = [
  ["mac os x", "macOS"],
  ["windows", "Windows"],
  ["linux", "Linux"],
  ["iphone", "iOS"],
  ["ipad", "iOS"],
  ["android", "Android"],
];

function firstMatch(
  table: readonly [needle: string, name: string][],
  haystack: string
): string | undefined {
  return table.find(([needle]) => haystack.includes(needle))?.[1];
}

function deviceIcon(lower: string): LucideIcon {
  if (MOBILE.test(lower)) {
    return Smartphone;
  }
  if (TABLET.test(lower)) {
    return Tablet;
  }
  return Laptop;
}

export function describeUserAgent(ua: string | null): {
  label: string;
  icon: LucideIcon;
} {
  if (!ua) {
    return { label: "Unknown device", icon: Monitor };
  }
  const lower = ua.toLowerCase();
  const browser = firstMatch(BROWSERS, lower) ?? "Browser";
  const os = firstMatch(OPERATING_SYSTEMS, lower) ?? "Unknown OS";
  return { icon: deviceIcon(lower), label: `${browser} on ${os}` };
}
