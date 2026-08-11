/**
 * Server-side User-Agent labelling. Used by the new-IP notification
 * email so the recipient can recognise (or fail to recognise) the
 * device that triggered the gate. Kept dependency-free so it can be
 * reused outside React components.
 */

export function describeUserAgentLabel(ua: string | null): string {
  if (!ua) {
    return "Unknown device";
  }
  const lower = ua.toLowerCase();
  let browser = "Browser";
  if (lower.includes("firefox")) {
    browser = "Firefox";
  } else if (lower.includes("edg/")) {
    browser = "Edge";
  } else if (lower.includes("brave")) {
    browser = "Brave";
  } else if (lower.includes("chrome")) {
    browser = "Chrome";
  } else if (lower.includes("safari")) {
    browser = "Safari";
  }
  let os = "Unknown OS";
  if (lower.includes("mac os x")) {
    os = "macOS";
  } else if (lower.includes("windows")) {
    os = "Windows";
  } else if (lower.includes("linux")) {
    os = "Linux";
  } else if (lower.includes("iphone") || lower.includes("ipad")) {
    os = "iOS";
  } else if (lower.includes("android")) {
    os = "Android";
  }
  return `${browser} on ${os}`;
}
