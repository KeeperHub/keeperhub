import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddMethodButton } from "@/components/failure-alerts/channel-list-editor";
import {
  type DraftChannel,
  restoreMethod,
} from "@/components/failure-alerts/method-drafts";
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
    expect(html).toContain(
      `Up to ${MAX_CHANNELS} chat or PagerDuty methods. Remove one to add another.`
    );
  });
});

const method = (n: number): DraftChannel => ({
  key: `k${n}`,
  kind: "slack",
  integrationId: "int_1",
  destination: `#ops-${n}`,
  role: "always",
});

describe("restoreMethod", () => {
  const full = Array.from({ length: MAX_CHANNELS }, (_, n) => method(n));

  it("puts a removed method back at its place", () => {
    const removed = full[3];
    const rest = full.filter((c) => c !== removed);
    expect(restoreMethod(rest, removed, 3)).toEqual(full);
  });

  it("refuses an Undo once another method took the free place", () => {
    // 20 methods: delete one, add another, then Undo.
    const removed = full[3];
    const refilled = [...full.filter((c) => c !== removed), method(99)];
    expect(refilled).toHaveLength(MAX_CHANNELS);
    expect(restoreMethod(refilled, removed, 3)).toBe("full");
  });

  it("does nothing when the method is back already", () => {
    expect(restoreMethod(full, full[0], 0)).toBeNull();
  });
});
