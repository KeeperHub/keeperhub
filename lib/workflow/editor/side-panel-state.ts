// The editor side panel's open state is kept per layout: from md to lg it opens
// over the canvas and starts closed, from lg it sits beside it and starts open.
const DESKTOP_COOKIE = "sidebar-collapsed";
const TABLET_COOKIE = "sidebar-collapsed-tablet";

export function sidePanelCookieName(belowLg: boolean): string {
  return belowLg ? TABLET_COOKIE : DESKTOP_COOKIE;
}

/** Whether the panel starts closed in this layout, from a `document.cookie` string. */
export function readSidePanelCollapsed(
  cookie: string,
  belowLg: boolean
): boolean {
  const prefix = `${sidePanelCookieName(belowLg)}=`;
  const row = cookie.split("; ").find((entry) => entry.startsWith(prefix));
  return row === undefined ? belowLg : row.slice(prefix.length) === "true";
}
