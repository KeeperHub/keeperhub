// Shared tab-value primitives. Lives in a pure (no "use client") module so
// both the server component host (app/hub/page.tsx) and the client tab shell
// (app/hub/_tabs-shell.tsx) can import the type guard. Calling the guard from
// a Server Component would otherwise fail with the Next.js "Attempted to call
// X() from the server but X is on the client" error.

export const HUB_TABS = ["protocols", "workflows", "marketplace"] as const;
export type HubTabValue = (typeof HUB_TABS)[number];

export function isHubTabValue(value: string): value is HubTabValue {
  return (HUB_TABS as readonly string[]).includes(value);
}
