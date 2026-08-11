import { Laptop, type LucideIcon, Monitor, Smartphone, Tablet } from "lucide-react";

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
export function describeUserAgent(ua: string | null): {
  label: string;
  icon: LucideIcon;
} {
  if (!ua) {
    return { label: "Unknown device", icon: Monitor };
  }
  const lower = ua.toLowerCase();
  const isMobile = /iphone|android.*mobile/.test(lower);
  const isTablet = /ipad|android(?!.*mobile)/.test(lower);
  const browser = lower.includes("firefox")
    ? "Firefox"
    : lower.includes("edg/")
      ? "Edge"
      : lower.includes("chrome")
        ? "Chrome"
        : lower.includes("safari")
          ? "Safari"
          : "Browser";
  const os = lower.includes("mac os x")
    ? "macOS"
    : lower.includes("windows")
      ? "Windows"
      : lower.includes("linux")
        ? "Linux"
        : lower.includes("iphone") || lower.includes("ipad")
          ? "iOS"
          : lower.includes("android")
            ? "Android"
            : "Unknown OS";
  const icon = isMobile ? Smartphone : isTablet ? Tablet : Laptop;
  return { label: `${browser} on ${os}`, icon };
}
