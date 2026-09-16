// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileEditorNotice } from "@/components/workflow/mobile-editor-notice";

/**
 * The mobile rule, as the product states it: manual workflow running and the
 * editor view are not offered on a phone. This component is what a phone gets on
 * a workflow route instead, so it has to say what is available rather than
 * leaving someone on a blank page, and it has to carry a way to the editor,
 * because a viewport size is not allowed to remove content outright.
 */
describe("MobileEditorNotice", () => {
  it("says the editor is desktop-only", () => {
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain("The editor is built for a desktop");
    expect(html).toContain("Authoring a workflow needs a larger screen.");
  });

  it("names the surfaces that do exist on a phone", () => {
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain(
      "Runs, their steps and analytics are all available on this device"
    );
  });

  it("offers the escape hatch rather than removing content with no way back", () => {
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain("Use the editor anyway");
  });

  it("heads with an h2, because the page can already carry an h1", () => {
    // A deleted workflow renders `Workflow Not Found` as an h1 on the same page.
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h1");
  });
});
