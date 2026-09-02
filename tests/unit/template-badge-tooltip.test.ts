import { describe, expect, it } from "vitest";
import {
  badgeTooltip,
  isBadgeClipped,
} from "@/components/ui/template-badge-editor";
import {
  getDisplayTextForTemplate,
  type TemplateNode,
} from "@/lib/workflow/editor/template-utils";

const EDIT_HINT = "Double-click to edit this reference";

const nodes: TemplateNode[] = [
  {
    id: "JRY0lGfsvlwszZ797lIFz",
    data: { label: "Get hat execution", type: "action" },
  },
  { id: "sT1lFq2xKmA9dPn4vBc0e", data: { label: "Manual", type: "trigger" } },
];

describe("badgeTooltip", () => {
  it("leads with the reference and keeps the hint on its own line", () => {
    const tooltip = badgeTooltip("Get hat execution.result.timestamp");

    expect(tooltip.split("\n")).toEqual([
      "Get hat execution.result.timestamp",
      EDIT_HINT,
    ]);
  });

  it("keeps a long path whole, since the badge itself is clipped", () => {
    const long = "Get hat execution.result.receipt.logs.0.args.tokenId";

    expect(badgeTooltip(long).startsWith(`${long}\n`)).toBe(true);
  });

  it("falls back to the hint alone when there is no display text", () => {
    expect(badgeTooltip("")).toBe(EDIT_HINT);
  });
});

describe("badgeTooltip over a rendered reference", () => {
  it("shows the full text of a reference the field clips", () => {
    const template =
      "{{@JRY0lGfsvlwszZ797lIFz:Get hat execution.result.timestamp}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    // The badge renders this text and the operand field clips it; the first
    // tooltip line has to carry the same text in full.
    expect(displayText).toBe("Get hat execution.result.timestamp");
    expect(badgeTooltip(displayText)).toBe(`${displayText}\n${EDIT_HINT}`);
  });

  it("uses the node's current label, not the one stored in the token", () => {
    const template = "{{@JRY0lGfsvlwszZ797lIFz:Old label.result.timestamp}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    expect(badgeTooltip(displayText).split("\n")[0]).toBe(
      "Get hat execution.result.timestamp"
    );
  });

  it("carries the reference of a badge whose node is gone", () => {
    const template = "{{@deletedNodeId:Deleted step.result.value}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    expect(badgeTooltip(displayText).split("\n")[0]).toBe(
      "Deleted step.result.value"
    );
  });

  it("covers a reference with no field path", () => {
    const template = "{{@sT1lFq2xKmA9dPn4vBc0e:Manual}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    expect(badgeTooltip(displayText)).toBe(`Manual\n${EDIT_HINT}`);
  });
});

describe("isBadgeClipped", () => {
  it("gates the tooltip off for a badge the field shows in full", () => {
    // "Manual.data" inside a 240px operand field.
    expect(isBadgeClipped({ right: 88, visibleWidth: 240 })).toBe(false);
  });

  it("catches a badge whose right edge runs past the field", () => {
    // "Get hat execution.result.timestamp" needs about 250px in the same field.
    expect(isBadgeClipped({ right: 250, visibleWidth: 240 })).toBe(true);
  });

  it("treats a badge ending exactly at the edge as shown in full", () => {
    expect(isBadgeClipped({ right: 240, visibleWidth: 240 })).toBe(false);
  });

  it("follows the field width, not the length of the reference", () => {
    // The same short "Manual.data" badge, in a field narrowed until it no
    // longer fits.
    expect(isBadgeClipped({ right: 88, visibleWidth: 240 })).toBe(false);
    expect(isBadgeClipped({ right: 88, visibleWidth: 60 })).toBe(true);
  });

  it("stays quiet before layout, when nothing has a width yet", () => {
    expect(isBadgeClipped({ right: 0, visibleWidth: 0 })).toBe(false);
  });
});
