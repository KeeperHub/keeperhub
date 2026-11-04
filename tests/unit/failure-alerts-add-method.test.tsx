import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddMethodButton } from "@/components/failure-alerts/channel-list-editor";
import { MAX_CHANNELS } from "@/lib/notifications/failure-alerts/constants";

const render = (count: number): string =>
  renderToStaticMarkup(
    <AddMethodButton buttonRef={null} count={count} onClick={() => undefined} />
  );

describe("AddMethodButton", () => {
  it("is on below the limit, with no hint", () => {
    const html = render(MAX_CHANNELS - 1);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("Up to");
  });

  it("is off at the limit and says why", () => {
    const html = render(MAX_CHANNELS);
    expect(html).toContain('disabled=""');
    expect(html).toContain(`Up to ${MAX_CHANNELS} chat or PagerDuty methods.`);
  });
});
