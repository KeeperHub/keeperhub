// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileEditorNotice } from "@/components/workflow/mobile-editor-notice";

/**
 * The mobile rule, as the product states it: manual workflow running and the
 * editor view are not offered on a phone. This component is what a phone gets
 * on a workflow route instead, so the copy has to say where the user can go
 * rather than leaving them on a blank page.
 */
describe("MobileEditorNotice", () => {
  it("says the editor is desktop-only", () => {
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain("Open this on a desktop");
    expect(html).toContain("The workflow editor is not available on a phone.");
  });

  it("names the surfaces that do exist on a phone", () => {
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain(
      "Runs, their steps and analytics are, from the menu."
    );
  });
});
