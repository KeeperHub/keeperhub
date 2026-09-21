import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { stripControlChars } from "@/lib/utils/control-chars";
import {
  buildTriggerEvent,
  cleanCustomDetails,
  cleanDisplayField,
  cleanLinks,
  describeTrims,
  type Trim,
} from "@/plugins/pagerduty/event-payload";

function summaryFor(value: string): string {
  const { body } = buildTriggerEvent({
    routingKey: "R",
    dedupKey: "k",
    timestamp: "T",
    input: { summary: value, severity: "error", source: "s" },
  });
  return body.payload?.summary ?? "";
}

/**
 * A templated field carries whatever an upstream step produced. A bidi
 * override reorders the text around it, so an alert can render in PagerDuty
 * and on a phone as something other than what its author wrote, and
 * zero-width characters make two different values look identical.
 */
describe("characters that must not reach an alert", () => {
  it.each([
    ["right-to-left override", "vault\u202E down", "vault down"],
    ["zero-width space", "a\u200Bb", "ab"],
    ["null byte", "a\u0000b", "ab"],
    ["C1 control", "a\u0085b", "ab"],
    ["line separator", "a\u2028b", "ab"],
    ["byte order mark", "a\ufeffb", "ab"],
    ["soft hyphen", "a\u00ADb", "ab"],
  ])("removes a %s from the summary", (_name, value, expected) => {
    expect(summaryFor(value)).toBe(expected);
  });

  it("keeps tabs and newlines, which a description is allowed", () => {
    const trims: Trim[] = [];
    const value = "line one\nline two\tindented";
    expect(cleanDisplayField(value, "Summary", trims)).toBe(value);
    expect(trims).toEqual([]);
  });

  it("leaves ordinary punctuation, markdown and urls alone", () => {
    const value = "**vault** down: see https://ex.com/a?b=1&c=2 (C:\\\\logs)";
    expect(summaryFor(value)).toBe(value);
  });

  it("says so rather than changing the text silently", () => {
    const trims: Trim[] = [];
    cleanDisplayField("a\u202Eb", "Summary", trims);
    expect(trims).toHaveLength(1);
    expect(trims[0].kind).toBe("control");
    expect(describeTrims(trims)).toContain("cannot go in an alert");
  });

  /**
   * The dedup key is matched by equality between a trigger and the resolve
   * that closes it, so cleaning it would orphan every alert already open
   * under the old value. It is never displayed where a reordering misleads.
   */
  it("leaves the dedup key exactly as it was derived", () => {
    const dirty = "key\u200Bwith\u202Emarks";
    const { body } = buildTriggerEvent({
      routingKey: "R",
      dedupKey: dirty,
      timestamp: "T",
      input: { summary: "s", severity: "error", source: "s" },
    });
    expect(body.dedup_key).toBe(dirty);
  });
});

/**
 * Custom details and link labels land in the alert body and the notification,
 * the same places the summary does. The summary was protected first and these
 * two were the fields left: an object nobody walks, and a label whose whole
 * job is to describe the href beside it.
 */
describe("the display fields that are not one string", () => {
  it("walks custom details, values and keys, however deep", () => {
    const trims: Trim[] = [];
    const cleaned = cleanCustomDetails(
      {
        "vault\u202Ename": "a\u200Bb",
        nested: { list: ["x\u202Ey", 7, null], flag: true },
      },
      "Details",
      trims
    );
    expect(cleaned).toEqual({
      vaultname: "ab",
      nested: { list: ["xy", 7, null], flag: true },
    });
    expect(trims).toHaveLength(1);
    expect(trims[0]).toMatchObject({ field: "Details", kind: "control" });
  });

  it("leaves details alone, and reports nothing, when they are clean", () => {
    const trims: Trim[] = [];
    const details = { vault: "A", ratio: 1.5, healthy: false };
    expect(cleanCustomDetails(details, "Details", trims)).toEqual(details);
    expect(trims).toEqual([]);
  });

  /**
   * A label reading one way beside an href pointing another is the whole
   * attack, and the href is only ever checked for its https scheme - a
   * reordering character after that spoofs the rest of the host.
   */
  it("cleans both halves of a link", () => {
    const trims: Trim[] = [];
    const cleaned = cleanLinks(
      [{ href: "https://ex.com/a\u202Eb", text: "vault\u202E A" }],
      "Links",
      trims
    );
    expect(cleaned).toEqual([{ href: "https://ex.com/ab", text: "vault A" }]);
    expect(trims).toHaveLength(1);
    expect(trims[0]).toMatchObject({ field: "Links", kind: "control" });
  });

  it("carries both through the event the step actually sends", () => {
    const { body, trims } = buildTriggerEvent({
      routingKey: "R",
      dedupKey: "k",
      timestamp: "T",
      input: {
        summary: "s",
        severity: "error",
        source: "s",
        customDetails: { note: "a\u202Eb" },
        links: [{ href: "https://ex.com", text: "see\u200Bit" }],
      },
    });
    expect(body.payload?.custom_details).toEqual({ note: "ab" });
    expect(body.links).toEqual([{ href: "https://ex.com", text: "seeit" }]);
    expect(describeTrims(trims)).toContain("cannot go in an alert");
  });

  it("still sends no links key when there are none", () => {
    const { body } = buildTriggerEvent({
      routingKey: "R",
      dedupKey: "k",
      timestamp: "T",
      input: { summary: "s", severity: "error", source: "s", links: [] },
    });
    expect(body.links).toBeUndefined();
  });
});

/**
 * The class lives in one module because two copies of a list declared to be
 * the same list drift, and silently on both sides. These are the two shapes
 * its callers ask for - the alert path keeps the line breaks a description is
 * allowed, the node label path keeps nothing and leaves a space behind.
 */
describe("the shared character class", () => {
  const reordering = ["\u202E", "\u200B", "\u0000", "\ufeff", "\u2066"];

  it("removes the same characters the alert path removes", () => {
    for (const char of reordering) {
      expect(stripControlChars(`a${char}b`)).toBe("ab");
      expect(cleanDisplayField(`a${char}b`, "Summary", [])).toBe("ab");
    }
  });

  it("keeps tab, newline and carriage return only when asked", () => {
    const value = "a\u0009b\u000Ac\u000Dd";
    expect(stripControlChars(value, { keepLineBreaks: true })).toBe(value);
    expect(stripControlChars(value)).toBe("abcd");
  });

  it("substitutes rather than removes when given a replacement", () => {
    expect(stripControlChars("a\u202Eb", { replacement: " " })).toBe("a b");
  });
});
