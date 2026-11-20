import { describe, expect, it } from "vitest";
import {
  escapeHiddenChars,
  stripControlChars,
} from "@/lib/utils/control-chars";

// Built from code points: the formatter turns an escape into the raw character.
function hidden(...codes: number[]): string {
  return String.fromCodePoint(...codes);
}

describe("stripControlChars stays narrow", () => {
  // Widening it to whole categories broke these in alerts and node labels.
  it.each([
    [
      "Scotland flag",
      hidden(
        0x1_f3_f4,
        0xe_00_67,
        0xe_00_62,
        0xe_00_73,
        0xe_00_63,
        0xe_00_74,
        0xe_00_7f
      ),
    ],
    ["Arabic number sign", `${hidden(0x6_00)}12`],
    ["emoji with a variation selector", hidden(0x27_64, 0xfe_0f)],
  ])("keeps the %s", (_name, text) => {
    expect(stripControlChars(text)).toBe(text);
  });
});

describe("escapeHiddenChars, for a value shown for inspection", () => {
  it("escapes every character stripControlChars removes, astral ones too", () => {
    for (let code = 0; code <= 0x10_ff_ff; code++) {
      if (code >= 0xd8_00 && code <= 0xdf_ff) {
        continue;
      }
      const char = hidden(code);
      if (stripControlChars(char) === "") {
        expect(escapeHiddenChars(char), code.toString(16)).not.toBe(char);
      }
    }
  });

  it.each([
    ["2060", "word joiner", "\\u2060"],
    ["180e", "Mongolian vowel separator", "\\u180e"],
    ["fff9", "interlinear annotation", "\\ufff9"],
    ["e0041", "tag character", "\\u{e0041}"],
    ["2028", "line separator", "\\u2028"],
    ["fe0f", "variation selector", "\\ufe0f"],
    ["3164", "Hangul filler", "\\u3164"],
    ["034f", "combining grapheme joiner", "\\u034f"],
  ])(
    "escapes U+%s (%s), which stripping leaves alone",
    (hex, _name, escaped) => {
      expect(escapeHiddenChars(`a${hidden(Number.parseInt(hex, 16))}b`)).toBe(
        `a${escaped}b`
      );
    }
  );

  it("leaves visible text and plain emoji as they are", () => {
    const text = `caf${hidden(0xe9)} ${hidden(0x1_f6_00)} true`;
    expect(escapeHiddenChars(text)).toBe(text);
  });
});
