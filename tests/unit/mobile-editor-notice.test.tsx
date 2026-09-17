// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(html).toContain("switch this browser to desktop mode");
  });

  it("names the surfaces that do exist on a phone", () => {
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain(
      "Runs, their steps and analytics are all available on this device"
    );
  });

  it("offers no way in, because there is no override any more", () => {
    // The product decision: switching the browser to desktop mode is the way
    // through, so the notice names that rather than carrying a control that would
    // only work on the devices the gate had to measure carefully to exclude.
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Use the editor anyway");
    expect(html).toContain("desktop mode");
  });

  it("heads with an h2, because the page can already carry an h1", () => {
    // A deleted workflow renders `Workflow Not Found` as an h1 on the same page.
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h1");
  });

  it("carries nothing to press, which is why it needs no pointer-events-auto", () => {
    // components/layout-content.tsx wraps every route's children in
    // pointer-events-none and pointer-events inherits. The analytics empty state
    // has one button and claims the class back for it; this state has no
    // interactive content, so it takes no wrapper and the shared class list stays
    // identical to the sibling it is composed from.
    const html = renderToStaticMarkup(<MobileEditorNotice />);
    expect(html).not.toContain("pointer-events-auto");
  });

  it("is composed the way the analytics empty state is composed", () => {
    // Read the sibling file rather than restating it here. The point of the check
    // is that these two states cannot drift into two designs, and a copied
    // expectation would drift with the component it is meant to hold.
    const sibling = readFileSync(
      resolve(process.cwd(), "components/analytics/empty-state.tsx"),
      "utf8"
    );
    const html = renderToStaticMarkup(<MobileEditorNotice />);

    for (const shared of [
      "flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center",
      "flex size-20 items-center justify-center rounded-2xl bg-muted",
      "size-10 text-muted-foreground",
      "space-y-2",
      "text-xl font-semibold tracking-tight",
      "max-w-sm text-sm text-muted-foreground",
    ]) {
      expect(sibling).toContain(shared);
      expect(html).toContain(shared);
    }
  });
});
