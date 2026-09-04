import { describe, expect, it } from "vitest";
import { negotiate, parseAccept, qualityFor } from "@/lib/site/accept";

/**
 * The four things acceptmarkdown.com checks, plus the two ways a naive
 * implementation gets it wrong: handing markdown to a browser (because the
 * browser's trailing wildcard "matches" text/markdown), and 406-ing a client
 * that sent no Accept header at all.
 */
describe("Accept negotiation", () => {
  const BROWSER_ACCEPT =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

  describe("serves markdown when asked for it", () => {
    it("honours a bare text/markdown request", () => {
      expect(negotiate("text/markdown")).toEqual({ kind: "markdown" });
    });

    it("honours markdown listed ahead of html by q-value", () => {
      expect(negotiate("text/markdown;q=1.0, text/html;q=0.5")).toEqual({
        kind: "markdown",
      });
    });

    it("ignores parameter order and casing", () => {
      expect(negotiate("TEXT/MARKDOWN ;Q=0.9, text/html;q=0.1")).toEqual({
        kind: "markdown",
      });
    });
  });

  describe("serves html to everything else", () => {
    it("gives a browser html despite its trailing wildcard", () => {
      expect(negotiate(BROWSER_ACCEPT)).toEqual({ kind: "html" });
    });

    it("treats a missing header as */* and serves html", () => {
      expect(negotiate(null)).toEqual({ kind: "html" });
    });

    it("treats an empty header as */* and serves html", () => {
      expect(negotiate("   ")).toEqual({ kind: "html" });
    });

    it("breaks an explicit tie in favour of html", () => {
      expect(negotiate("text/markdown;q=0.8, text/html;q=0.8")).toEqual({
        kind: "html",
      });
    });

    it("serves html for a bare wildcard", () => {
      expect(negotiate("*/*")).toEqual({ kind: "html" });
    });

    it("serves html when only text/* is offered", () => {
      // text/* matches both candidates at the same q, so the tie-break applies.
      expect(negotiate("text/*")).toEqual({ kind: "html" });
    });
  });

  describe("rejects what it cannot serve", () => {
    it("406s a client that accepts only json", () => {
      expect(negotiate("application/json")).toEqual({
        kind: "not-acceptable",
      });
    });

    it("406s when both candidates are explicitly refused", () => {
      expect(negotiate("*/*;q=0")).toEqual({ kind: "not-acceptable" });
    });

    it("406s when markdown is asked for but html and markdown are both q=0", () => {
      expect(negotiate("text/html;q=0, text/markdown;q=0")).toEqual({
        kind: "not-acceptable",
      });
    });
  });

  describe("q-value handling", () => {
    it("defaults an unqualified range to 1", () => {
      expect(qualityFor(parseAccept("text/markdown"), "text/markdown")).toBe(1);
    });

    it("prefers the most specific matching range, not the first", () => {
      // */*;q=0.1 appears first but text/markdown is more specific, so 0.9 wins.
      const entries = parseAccept("*/*;q=0.1, text/markdown;q=0.9");
      expect(qualityFor(entries, "text/markdown")).toBe(0.9);
      expect(qualityFor(entries, "text/html")).toBe(0.1);
    });

    it("clamps an out-of-range q rather than rejecting the header", () => {
      expect(
        qualityFor(parseAccept("text/markdown;q=5"), "text/markdown")
      ).toBe(1);
      expect(
        qualityFor(parseAccept("text/markdown;q=-2"), "text/markdown")
      ).toBe(0);
    });

    it("falls back to q=1 when the q parameter is unparseable", () => {
      expect(
        qualityFor(parseAccept("text/markdown;q=banana"), "text/markdown")
      ).toBe(1);
    });

    it("skips malformed ranges without discarding the rest of the header", () => {
      const entries = parseAccept("garbage, text/markdown;q=0.9");
      expect(qualityFor(entries, "text/markdown")).toBe(0.9);
    });

    it("falls back to the wildcard for an absurdly long header", () => {
      const flood = `${"text/markdown, ".repeat(1000)}text/html`;
      expect(negotiate(flood)).toEqual({ kind: "html" });
    });
  });
});
