/**
 * Opt-in escaping of substituted template values.
 *
 * `processActionConfig` resolves every {{...}} reference before a step runs, so
 * the step only ever sees one flat string. A config field can declare
 * `escapeSubstitutions` to have the values that were substituted into it
 * escaped while the author's own markup is left alone.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  escapeHtmlSubstitution,
  getEscapedSubstitutionFields,
  renderTemplateString,
} from "@/lib/workflow/executor/executor.workflow";

const TELEGRAM = "telegram/send-message";

const outputs = {
  read: {
    label: "Read",
    data: {
      balance: "5 < 10",
      note: "Tom & Jerry",
      injected: '<a href="https://evil.example/drain">Claim refund</a>',
      count: 3,
    },
  },
};

describe("escapeHtmlSubstitution", () => {
  it("escapes the three characters Telegram parses as markup", () => {
    expect(escapeHtmlSubstitution('<a href="x">&</a>')).toBe(
      '&lt;a href="x"&gt;&amp;&lt;/a&gt;'
    );
  });

  it("leaves quotes and other characters alone", () => {
    expect(escapeHtmlSubstitution('it\'s 5% "done"')).toBe('it\'s 5% "done"');
  });
});

describe("getEscapedSubstitutionFields", () => {
  it("selects the telegram message field when parse mode is HTML", () => {
    const fields = getEscapedSubstitutionFields(TELEGRAM, {
      message: "hello",
      parseMode: "HTML",
    });
    expect(fields.map((f) => f.key)).toEqual(["message"]);
  });

  it("selects nothing for MarkdownV2", () => {
    expect(
      getEscapedSubstitutionFields(TELEGRAM, {
        message: "hello",
        parseMode: "MarkdownV2",
      })
    ).toEqual([]);
  });

  it("selects nothing for plain text", () => {
    expect(
      getEscapedSubstitutionFields(TELEGRAM, {
        message: "hello",
        parseMode: "none",
      })
    ).toEqual([]);
  });

  it("selects nothing when the field value is not a string", () => {
    expect(
      getEscapedSubstitutionFields(TELEGRAM, {
        message: 42,
        parseMode: "HTML",
      })
    ).toEqual([]);
  });

  it("leaves other plugins untouched", () => {
    expect(
      getEscapedSubstitutionFields("discord/send-message", {
        discordMessage: "hello",
        parseMode: "HTML",
      })
    ).toEqual([]);
  });

  it("returns nothing for an unknown action type", () => {
    expect(getEscapedSubstitutionFields("nope/nope", { a: "b" })).toEqual([]);
  });
});

describe("renderTemplateString with an escaper", () => {
  it("escapes < in a substituted value and keeps the author's tags", () => {
    expect(
      renderTemplateString(
        "<b>Balance</b>: {{@read:Read.balance}}",
        outputs,
        undefined,
        escapeHtmlSubstitution
      )
    ).toBe("<b>Balance</b>: 5 &lt; 10");
  });

  it("escapes & in a substituted value", () => {
    expect(
      renderTemplateString(
        "<i>{{@read:Read.note}}</i>",
        outputs,
        undefined,
        escapeHtmlSubstitution
      )
    ).toBe("<i>Tom &amp; Jerry</i>");
  });

  it("renders an anchor tag from upstream data as inert text", () => {
    expect(
      renderTemplateString(
        "Alert: {{@read:Read.injected}}",
        outputs,
        undefined,
        escapeHtmlSubstitution
      )
    ).toBe(
      'Alert: &lt;a href="https://evil.example/drain"&gt;Claim refund&lt;/a&gt;'
    );
  });

  it("escapes display-format references too", () => {
    expect(
      renderTemplateString(
        "{{Read.balance}}",
        outputs,
        undefined,
        escapeHtmlSubstitution
      )
    ).toBe("5 &lt; 10");
  });

  it("escapes every reference in a string, not only the first", () => {
    expect(
      renderTemplateString(
        "{{@read:Read.balance}} / {{@read:Read.note}}",
        outputs,
        undefined,
        escapeHtmlSubstitution
      )
    ).toBe("5 &lt; 10 / Tom &amp; Jerry");
  });

  it("leaves the value untouched without an escaper", () => {
    expect(renderTemplateString("<b>{{@read:Read.balance}}</b>", outputs)).toBe(
      "<b>5 < 10</b>"
    );
  });

  it("keeps non-string values rendering as before", () => {
    expect(
      renderTemplateString(
        "count={{@read:Read.count}}",
        outputs,
        undefined,
        escapeHtmlSubstitution
      )
    ).toBe("count=3");
  });
});
