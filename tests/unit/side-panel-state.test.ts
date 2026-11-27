import { describe, expect, it } from "vitest";
import {
  readSidePanelCollapsed,
  sidePanelCookieName,
} from "@/lib/workflow/editor/side-panel-state";

describe("side panel open state per layout", () => {
  it("starts closed from md to lg and open from lg", () => {
    expect(readSidePanelCollapsed("", true)).toBe(true);
    expect(readSidePanelCollapsed("", false)).toBe(false);
  });

  it("keeps each layout's choice apart", () => {
    const cookie = "theme=dark; sidebar-collapsed=false; other=1";
    // Open on the desktop leaves the tablet layout at its own default.
    expect(readSidePanelCollapsed(cookie, false)).toBe(false);
    expect(readSidePanelCollapsed(cookie, true)).toBe(true);

    const opened = "sidebar-collapsed-tablet=false; sidebar-collapsed=true";
    expect(readSidePanelCollapsed(opened, true)).toBe(false);
    expect(readSidePanelCollapsed(opened, false)).toBe(true);
  });

  it("names one cookie per layout", () => {
    expect(sidePanelCookieName(false)).toBe("sidebar-collapsed");
    expect(sidePanelCookieName(true)).toBe("sidebar-collapsed-tablet");
  });
});
