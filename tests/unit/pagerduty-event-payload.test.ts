import { describe, expect, it } from "vitest";
import {
  buildTriggerEvent,
  buildUpdateEvent,
  deriveDedupKey,
  describeTrims,
  FIELD_LIMITS,
  MAX_DEDUP_KEY_CHARS,
  MAX_EVENT_BYTES,
  MAX_SUMMARY_CHARS,
  normaliseSeverity,
  parseLinks,
  truncateRunes,
} from "@/plugins/pagerduty/event-payload";

const BASE_INPUT = {
  summary: "Keeper stalled",
  severity: "error",
  source: "keeper-watchdog",
};

function build(overrides: Record<string, unknown> = {}) {
  return buildTriggerEvent({
    routingKey: "R0123456789ABCDEF0123456789ABCDE",
    dedupKey: "keeperhub/wf/node",
    timestamp: "2026-09-16T10:00:00.000Z",
    input: { ...BASE_INPUT, ...overrides },
  });
}

describe("truncateRunes", () => {
  it("leaves a short string alone", () => {
    expect(truncateRunes("short", 10)).toBe("short");
  });

  it("counts runes, not code units, so an emoji is not cut in half", () => {
    const value = "ab\u{1F600}cd";
    expect(truncateRunes(value, 3)).toBe("ab\u{1F600}");
  });
});

describe("normaliseSeverity", () => {
  it.each(["critical", "error", "warning", "info"])("accepts %s", (value) => {
    expect(normaliseSeverity(value)).toBe(value);
  });

  it("is case and whitespace insensitive", () => {
    expect(normaliseSeverity("  CRITICAL ")).toBe("critical");
  });

  it("falls back to error for anything else", () => {
    expect(normaliseSeverity("catastrophic")).toBe("error");
    expect(normaliseSeverity(undefined)).toBe("error");
    expect(normaliseSeverity(42)).toBe("error");
  });
});

describe("deriveDedupKey", () => {
  it("uses the configured key when there is one", () => {
    expect(deriveDedupKey("  vault-7  ", {})).toBe("vault-7");
  });

  it("derives a node-scoped key so repeat runs group into one alert", () => {
    expect(deriveDedupKey(undefined, { workflowId: "wf1", nodeId: "n3" })).toBe(
      "keeperhub/wf1/n3"
    );
  });

  it("is stable across runs of the same node", () => {
    const context = { workflowId: "wf1", nodeId: "n3" };
    expect(deriveDedupKey("", context)).toBe(deriveDedupKey("", context));
  });

  it("caps the key at PagerDuty's limit", () => {
    const key = deriveDedupKey("x".repeat(400), {});
    expect(key).toHaveLength(MAX_DEDUP_KEY_CHARS);
  });
});

describe("buildTriggerEvent", () => {
  it("sends the fields PagerDuty requires", () => {
    const { body } = build();
    expect(body.routing_key).toBe("R0123456789ABCDEF0123456789ABCDE");
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe("keeperhub/wf/node");
    expect(body.payload?.summary).toBe("Keeper stalled");
    expect(body.payload?.severity).toBe("error");
    expect(body.payload?.source).toBe("keeper-watchdog");
    expect(body.payload?.timestamp).toBe("2026-09-16T10:00:00.000Z");
  });

  it("truncates the summary to the documented limit", () => {
    const { body } = build({ summary: "a".repeat(MAX_SUMMARY_CHARS + 500) });
    expect(body.payload?.summary).toHaveLength(MAX_SUMMARY_CHARS);
  });

  it("omits blank optional fields rather than sending empty strings", () => {
    const { body } = build({ component: "   ", group: "", class: undefined });
    expect(body.payload?.component).toBeUndefined();
    expect(body.payload?.group).toBeUndefined();
    expect(body.payload?.class).toBeUndefined();
  });

  it("keeps custom details that fit", () => {
    const { body, detailsDropped } = build({
      customDetails: { vault: "0xabc" },
    });
    expect(detailsDropped).toBe(false);
    expect(body.payload?.custom_details).toEqual({ vault: "0xabc" });
  });

  it("drops oversized custom details and says why, instead of losing the page", () => {
    const { body, detailsDropped } = build({
      customDetails: { blob: "x".repeat(MAX_EVENT_BYTES) },
    });
    expect(detailsDropped).toBe(true);
    expect(JSON.stringify(body.payload?.custom_details)).toContain(
      "Custom details were removed"
    );
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThan(
      MAX_EVENT_BYTES
    );
    // The alert itself survives: summary and routing are untouched.
    expect(body.payload?.summary).toBe("Keeper stalled");
    expect(body.routing_key).toBe("R0123456789ABCDEF0123456789ABCDE");
  });

  it("normalises an unknown severity rather than letting PagerDuty reject it", () => {
    const { body } = build({ severity: "disaster" });
    expect(body.payload?.severity).toBe("error");
  });
});

describe("buildUpdateEvent", () => {
  it("carries only what an acknowledge or resolve needs", () => {
    const body = buildUpdateEvent({
      routingKey: "R1",
      dedupKey: "vault-7",
      action: "resolve",
    });
    expect(body).toEqual({
      routing_key: "R1",
      event_action: "resolve",
      dedup_key: "vault-7",
    });
    // PagerDuty ignores a payload on these actions; sending one is noise.
    expect(body.payload).toBeUndefined();
  });
});

/**
 * The size guard can only drop custom details and links. A grouping field that
 * rendered to something enormous took the event over the limit with nothing
 * left to sacrifice, and PagerDuty rejected the whole page.
 */
describe("grouping fields", () => {
  it.each(["component", "group", "class"])("bounds %s", (field) => {
    const { body } = buildTriggerEvent({
      routingKey: "R1",
      dedupKey: "k1",
      timestamp: "2026-01-01T00:00:00Z",
      input: {
        summary: "s",
        severity: "error",
        source: "src",
        [field]: "x".repeat(5000),
      },
    });
    const payload = body.payload as unknown as Record<string, string>;
    expect(payload[field]).toHaveLength(1024);
  });
});

describe("parseLinks", () => {
  it("takes a bare url and uses it as its own text", () => {
    expect(parseLinks("https://etherscan.io/tx/0x1")).toEqual({
      links: [
        {
          href: "https://etherscan.io/tx/0x1",
          text: "https://etherscan.io/tx/0x1",
        },
      ],
      dropped: 0,
    });
  });

  it("takes text | url and keeps the text", () => {
    expect(parseLinks("Etherscan | https://etherscan.io/tx/0x1").links).toEqual(
      [{ href: "https://etherscan.io/tx/0x1", text: "Etherscan" }]
    );
  });

  /**
   * A label is free text. Taking the second field rather than the last threw
   * the url away and kept the middle of the label, which then failed the https
   * check - so the line vanished from a well-formed entry.
   */
  it("takes the url as the last field, so a label may contain a separator", () => {
    expect(
      parseLinks(
        "Vault A | liquidation risk | https://etherscan.io/address/0x1"
      )
    ).toEqual({
      links: [
        {
          href: "https://etherscan.io/address/0x1",
          text: "Vault A | liquidation risk",
        },
      ],
      dropped: 0,
    });
  });

  it("ignores blank lines without counting them as dropped", () => {
    const parsed = parseLinks("https://a.example\n\n  \nhttps://b.example");
    expect(parsed.links).toHaveLength(2);
    expect(parsed.dropped).toBe(0);
  });

  /**
   * A responder opening a link is the first thing that happens after a page,
   * and a line that quietly never arrives is the worst way to find out the
   * field wanted https. The count is what the node reports and the preview
   * shows.
   */
  it("counts the lines it could not use", () => {
    const parsed = parseLinks(
      [
        "https://ok.example",
        "http://plaintext.example",
        "Dashboard | ftp://nope.example",
        "just some words",
      ].join("\n")
    );
    expect(parsed.links).toEqual([
      { href: "https://ok.example", text: "https://ok.example" },
    ]);
    expect(parsed.dropped).toBe(3);
  });

  it("has nothing to say about an empty field", () => {
    expect(parseLinks(undefined)).toEqual({ links: [], dropped: 0 });
    expect(parseLinks("   ")).toEqual({ links: [], dropped: 0 });
  });
});

/**
 * PagerDuty documents 1024 characters for an alert summary, 255 for a dedup
 * key, and rejects an event over 512 KB whole. Trimming rather than refusing
 * is the right trade for an alerting node - a shortened title still wakes the
 * right person - but the author is the only one who can fix it and they will
 * not be reading the incident, so nothing may be trimmed in silence.
 */
describe("field limits are enforced and reported", () => {
  function build(input: Record<string, unknown>) {
    return buildTriggerEvent({
      routingKey: "R1",
      dedupKey: "k1",
      timestamp: "2026-01-01T00:00:00Z",
      input: {
        summary: "s",
        severity: "error",
        source: "src",
        ...input,
      } as never,
    });
  }

  it("matches PagerDuty's documented ceilings", () => {
    expect(FIELD_LIMITS.Summary).toBe(1024);
    expect(FIELD_LIMITS["Dedup key"]).toBe(255);
  });

  it("says nothing when everything fits", () => {
    const { trims } = build({});
    expect(trims).toEqual([]);
    expect(describeTrims(trims)).toBeUndefined();
  });

  it("names the field, its real length and the limit", () => {
    const { body, trims } = build({ summary: "x".repeat(2000) });
    expect(body.payload?.summary).toHaveLength(1024);
    expect(trims).toEqual([
      { field: "Summary", from: 2000, to: 1024, kind: "limit" },
    ]);
    expect(describeTrims(trims)).toBe(
      "Summary was 2000 characters and PagerDuty takes 1024, so it was shortened"
    );
  });

  it("reports every field it had to shorten, not just the first", () => {
    const { trims } = build({
      summary: "x".repeat(1100),
      source: "y".repeat(1100),
      component: "z".repeat(1100),
    });
    expect(trims.map((t) => t.field)).toEqual([
      "Summary",
      "Source",
      "Component",
    ]);
  });

  /** Counted in characters, so a multi-byte summary is not cut mid-character. */
  it("counts runes rather than code units", () => {
    const { body, trims } = build({ summary: "\u{1F525}".repeat(1100) });
    expect([...(body.payload?.summary ?? "")]).toHaveLength(1024);
    expect(trims[0]).toMatchObject({ from: 1100, to: 1024 });
  });
});
