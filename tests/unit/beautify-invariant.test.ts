// The suite's other files pin hand-written expected output, case by case.
// That catches what it was written for and nothing else: the edge-case file's
// oracle compares only the references found on each side, so it is blind to
// anything that happens to the text between them - which is where two of the
// three value bugs in this feature lived.
//
// This file states the invariant directly instead, over generated input:
// formatting changes whitespace and nothing else. The comparison deliberately
// does NOT reuse the implementation's scanner; it re-derives the token stream
// from the JSON grammar so a bug in the masker cannot hide behind itself.

import { describe, expect, it } from "vitest";

import { beautifyJson } from "@/lib/utils/beautify";

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const STRUCTURAL = new Set(["{", "}", "[", "]", ",", ":"]);
const STRICT_REFERENCE = /^\{\{[^{}"\n\r]*\}\}/;

/** Independent tokenizer, written against the grammar, not against the code. */
function tokensOf(source: string): string[] {
  const out: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (WHITESPACE.has(char)) {
      index += 1;
      continue;
    }

    if (char === "{" && source[index + 1] === "{") {
      const match = STRICT_REFERENCE.exec(source.slice(index));
      if (match) {
        out.push(`ref:${match[0]}`);
        index += match[0].length;
        continue;
      }
    }

    if (STRUCTURAL.has(char)) {
      out.push(char);
      index += 1;
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      out.push(`str:${source.slice(index, end)}`);
      index = end;
      continue;
    }

    let end = index;
    while (
      end < source.length &&
      !(WHITESPACE.has(source[end]) || STRUCTURAL.has(source[end]))
    ) {
      end += 1;
    }
    out.push(`lit:${source.slice(index, end)}`);
    index = end;
  }

  return out;
}

const STRINGS = [
  '"x"',
  '"a b"',
  '"{{A.k}}"',
  '"pre {{A.k}} post"',
  '"note {{ typo"',
  '"trail }} here"',
  '"esc \\" q"',
  '"back \\\\"',
  '"u \\u00e9"',
  '"br {{ and }} ce"',
  '"{{@n1:Read Hat.result}}"',
  '"__KH_TPL_0__"',
  '"KH_TPL__KH_TPL_0__"',
  '"KH_TPL___KH_TPL_0__"',
  '"{{not{a}ref}}"',
  '"colon: comma, brace }"',
];

const SCALARS = [
  "1",
  "0",
  "-0",
  "1e3",
  "1.0",
  "12345678901234567890",
  "true",
  "false",
  "null",
  "{{A.k}}",
  "{{@n1:L.f}}",
  "{{}}",
];

// Deterministic generator: a seeded LCG, so a failure reproduces from its seed.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_00_00_00_00;
  };
}

function generate(random: () => number, depth: number): string {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

  if (depth <= 0) {
    return pick([...STRINGS, ...SCALARS]);
  }
  const shape = Math.floor(random() * 3);
  const count = Math.floor(random() * 4);

  if (shape === 0) {
    const items = Array.from({ length: count }, () =>
      generate(random, depth - 1)
    );
    return `[${items.join(",")}]`;
  }
  if (shape === 1) {
    const items = Array.from(
      { length: count },
      (_unused, key) => `"k${key}":${generate(random, depth - 1)}`
    );
    return `{${items.join(",")}}`;
  }
  return pick([...STRINGS, ...SCALARS]);
}

/**
 * The strongest oracle in the file, and the simplest: if formatting only
 * changes whitespace then removing all whitespace from both sides leaves
 * identical text. It needs no grammar and no tokenizer, so unlike `tokensOf`
 * it cannot restate a rule the implementation also gets wrong - which is how
 * a prefix collision that rewrote the user's text slipped past the other
 * assertions here.
 */
function withoutWhitespace(text: string): string {
  return text.replace(/[ \t\n\r]/g, "");
}

describe("beautifyJson only ever changes whitespace", () => {
  it.each([1, 2, 3, 4, 5])(
    "holds across generated documents, seed %i",
    (seed) => {
      const random = makeRandom(seed * 7919);
      let formatted = 0;
      let rejected = 0;

      for (let n = 0; n < 4000; n += 1) {
        const source = generate(random, 1 + Math.floor(random() * 3));
        const outcome = beautifyJson(source);
        if (!outcome.ok) {
          rejected += 1;
          continue;
        }
        formatted += 1;
        expect(withoutWhitespace(outcome.value), `source: ${source}`).toBe(
          withoutWhitespace(source)
        );
        expect(tokensOf(outcome.value), `source: ${source}`).toEqual(
          tokensOf(source)
        );
        const again = beautifyJson(outcome.value);
        expect(again.ok, `source: ${source}`).toBe(true);
        if (again.ok) {
          expect(again.value, `source: ${source}`).toBe(outcome.value);
        }
      }

      // Guard against the generator degenerating into cases that all reject,
      // which would make the assertions above vacuous.
      expect(formatted).toBeGreaterThan(rejected);
    }
  );
});

describe("valid JSON is not refused", () => {
  // Strings stuffed with the characters the scanner cares about: a document
  // that JSON.parse accepts must never be rejected just because a string
  // inside it looks a little like a reference.
  const JUNK = [
    "plain",
    "{{",
    "}}",
    "{{ oops",
    "x}}y",
    "{{A.k}}",
    "{{not{a}ref}}",
    'quote " here',
    "back \\ slash",
    "line\nbreak",
    "__KH_TPL_0__",
    "KH_TPL__KH_TPL_0__",
    "KH_TPL___KH_TPL_0__",
  ];

  function value(random: () => number, depth: number): unknown {
    const pick = <T>(items: T[]): T =>
      items[Math.floor(random() * items.length)];
    if (depth <= 0) {
      return pick<unknown>([...JUNK, 1, 0, -1, true, false, null]);
    }
    const count = Math.floor(random() * 4);
    if (random() < 0.5) {
      return Array.from({ length: count }, () => value(random, depth - 1));
    }
    const object: Record<string, unknown> = {};
    for (let key = 0; key < count; key += 1) {
      object[`${pick(JUNK)}${key}`] = value(random, depth - 1);
    }
    return object;
  }

  it.each([11, 12, 13])("holds for seed %i", (seed) => {
    const random = makeRandom(seed * 104_729);
    for (let n = 0; n < 2000; n += 1) {
      const source = JSON.stringify(value(random, 2));
      const outcome = beautifyJson(source);
      expect(outcome.ok, `source: ${source}`).toBe(true);
      if (outcome.ok) {
        // and it still parses to the same thing
        expect(JSON.parse(outcome.value), `source: ${source}`).toEqual(
          JSON.parse(source)
        );
      }
    }
  });
});
