// Config fields carry upstream references in every position a user can put
// them, and the masking has to survive all of them. Each case here was run
// against the real implementation first; they are pinned so a change to the
// scanner cannot quietly start eating someone's field.
//
// The invariant under test is the same throughout: the set of `{{...}}` runs
// in the output equals the set in the input, in order, byte for byte.

import { describe, expect, it } from "vitest";

import { beautifyJavaScript, beautifyJson } from "@/lib/utils/beautify";

const REFERENCE = /\{\{[^}]*\}\}/g;

function referencesIn(text: string): string[] {
  return text.match(REFERENCE) ?? [];
}

function expectValue(outcome: {
  ok: boolean;
  value?: string;
  error?: string;
}): string {
  expect(outcome.error ?? null).toBeNull();
  expect(outcome.ok).toBe(true);
  return outcome.value as string;
}

const JSON_CASES: [name: string, source: string][] = [
  ["reference inside a string", '{"a":"Bearer {{A.k}}"}'],
  ["reference is the whole string", '{"a":"{{A.k}}"}'],
  ["reference in value position", '{"a":{{A.k}}}'],
  ["two references in one string", '{"a":"{{A.x}}/{{A.y}}"}'],
  ["adjacent references", '{"a":"{{A.x}}{{A.y}}"}'],
  ["reference inside a key", '{"pre{{A.k}}":1}'],
  ["stored node-id form, quoted", '{"a":"{{@n1:Read Hat.result}}"}'],
  ["stored node-id form, bare", '{"a":{{@n1:Read Hat.result}}}'],
  ["references in an array", '[{{A.x}},1,"{{A.y}}"]'],
  ["the whole document is a reference", "{{A.all}}"],
  ["regex metacharacters in a reference", '{"a":"{{A.$&b}}"}'],
  ["escaped quotes around a reference", '{"a":"x\\"{{A.k}}\\"y"}'],
  ["escaped backslash before a reference", '{"a":"x\\\\","b":{{A.k}}}'],
  ["unicode escape beside a reference", '{"a":"\\u00e9 {{A.k}}"}'],
  ["escaped braces are not a reference", '{"re":"^\\\\{\\\\{x"}'],
  ["prose braces round-trip unchanged", '{"note":"use {{ and }} carefully"}'],
  [
    "the same reference several times",
    '{"a":{{X.y}},"b":{{X.y}},"c":"{{X.y}}"}',
  ],
  ["placeholder text already in the data", '{"a":"__KH_TPL_0__","b":{{X.y}}}'],
  ["a wider placeholder collision", '{"a":"___KH_TPL_0__","b":{{X.y}}}'],
  ["deep nesting", '{"a":{"b":{"c":[{"d":{{A.k}}}]}}}'],
];

describe("beautifyJson keeps every reference byte for byte", () => {
  it.each(JSON_CASES)("%s", (_name, source) => {
    const value = expectValue(beautifyJson(source));
    expect(referencesIn(value)).toEqual(referencesIn(source));
  });

  it.each(JSON_CASES)("%s is idempotent", (_name, source) => {
    const once = expectValue(beautifyJson(source));
    expect(expectValue(beautifyJson(once))).toBe(once);
  });
});

describe("beautifyJson accepts the shapes a config field really holds", () => {
  it("normalises CRLF and stray outer whitespace", () => {
    expect(expectValue(beautifyJson('  {\r\n"a":1\r\n}  '))).toBe(
      '{\n  "a": 1\n}'
    );
  });

  it("keeps every numeric spelling", () => {
    const value = expectValue(
      beautifyJson('{"a":-0,"b":1E+5,"c":0.0,"d":1e-7}')
    );
    expect(value).toContain("-0");
    expect(value).toContain("1E+5");
    expect(value).toContain("0.0");
    expect(value).toContain("1e-7");
  });

  it("survives sixty levels of nesting without recursing", () => {
    const deep = `${"[".repeat(60)}1${"]".repeat(60)}`;
    expect(expectValue(beautifyJson(deep))).toContain("1");
  });

  it("leaves an unterminated reference alone", () => {
    const value = expectValue(beautifyJson('{"a":"{{A.k"}'));
    expect(value).toContain('"{{A.k"');
  });
});

const JS_CASES: [name: string, source: string][] = [
  ["expression position", "const C={{A.result}};"],
  ["inside a single-quoted string", "const u='x/{{A.id}}/y';"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate test data - a JS template literal the masking must leave alone
  ["inside a template literal", "const u=`x/{{A.id}}/${n}`;"],
  ["inside a line comment", "// see {{A.id}}\nconst a=1;"],
  ["inside a block comment", "/* {{A.id}} */ const a=1;"],
  ["as an object value", "const o={k:{{A.v}},j:2};"],
  ["as an object key", "const o={ {{A.k}}: 1 };"],
  ["as a call argument", "f({{A.v}}, 2);"],
  ["with member access", "const x={{A.v}}.field;"],
  ["with optional chaining", "const v={{A.k}}?.x;"],
  ["inside a regex literal", "const re=/{{A.k}}/;"],
  ["two references", "const a={{A.x}}+{{A.y}};"],
  ["stored node-id form", "const C={{@n1:Set constants.result}};"],
  [
    "placeholder text already in the code",
    "const __KH_TPL_0__=1;const C={{A.k}};",
  ],
];

describe("beautifyJavaScript keeps every reference byte for byte", () => {
  it.each(JS_CASES)("%s", async (_name, source) => {
    const value = expectValue(await beautifyJavaScript(source));
    expect(referencesIn(value)).toEqual(referencesIn(source));
  });

  it.each(JS_CASES)("%s is idempotent", async (_name, source) => {
    const once = expectValue(await beautifyJavaScript(source));
    expect(expectValue(await beautifyJavaScript(once))).toBe(once);
  });
});

describe("beautifyJavaScript accepts a code node's own dialect", () => {
  it("allows a top-level return", async () => {
    expect(expectValue(await beautifyJavaScript("return {ids:[1,2]};"))).toBe(
      "return { ids: [1, 2] };\n"
    );
  });

  it("allows a top-level await", async () => {
    const value = expectValue(
      await beautifyJavaScript("const r=await fetch(u);return r;")
    );
    expect(value).toContain("await fetch(u)");
  });

  it("leaves blank input alone", async () => {
    expect(expectValue(await beautifyJavaScript("   \n  "))).toBe("   \n  ");
  });
});

// A stray `{{` in prose used to swallow everything up to the next unrelated
// `}}`, masking it as one opaque span. Nothing was corrupted - the span came
// back byte for byte - but the formatter silently skipped it and still
// reported success, so part of the field stayed unformatted with no hint why.
//
// These assert the exact output rather than comparing reference runs against
// each other: the naive `/\{\{[^}]*\}\}/g` oracle used above captures the same
// over-wide span on both sides and would agree the swallow "round-tripped".
describe("a stray opening brace does not swallow the rest of the field", () => {
  it("formats every pair when prose contains an unmatched {{", () => {
    const outcome = beautifyJson(
      '{"a": "note {{ typo", "b": "{{Real.ref}}", "c": 5}'
    );
    expect(expectValue(outcome)).toBe(
      '{\n  "a": "note {{ typo",\n  "b": "{{Real.ref}}",\n  "c": 5\n}'
    );
  });

  it("formats code after a comment containing an unmatched {{", async () => {
    const value = expectValue(
      await beautifyJavaScript(
        "const a=1;\n// TODO: implement {{ properly\nconst config = {a: {{Node.value}}};\nconst b=2;"
      )
    );
    expect(value).toContain("const config = { a: {{Node.value}} };");
    expect(value).toContain("const b = 2;");
  });

  it("treats a body containing a brace as text, not a reference", () => {
    const outcome = beautifyJson('{"a":"x {{not{a}ref}} y","b":1}');
    expect(expectValue(outcome)).toBe(
      '{\n  "a": "x {{not{a}ref}} y",\n  "b": 1\n}'
    );
  });

  it("still recognises a reference that follows a stray opener", () => {
    const outcome = beautifyJson('{"a":"{{ oops","b":{{Real.ref}}}');
    expect(expectValue(outcome)).toBe(
      '{\n  "a": "{{ oops",\n  "b": {{Real.ref}}\n}'
    );
  });
});

// A reference's body carries no quote or line break either. Bounding only on
// `{` left a gap with no brace in it still able to swallow.
describe("the reference bound is tight enough", () => {
  it("formats every pair when the gap holds no brace", () => {
    const outcome = beautifyJson('{"a": "{{ oops", "b": "x}}y", "c": 3}');
    expect(expectValue(outcome)).toBe(
      '{\n  "a": "{{ oops",\n  "b": "x}}y",\n  "c": 3\n}'
    );
  });

  it("does not treat a span crossing a line break as a reference", () => {
    const outcome = beautifyJson('{"a":"{{ x","b":"y}}z","c":1}');
    expect(expectValue(outcome)).toBe(
      '{\n  "a": "{{ x",\n  "b": "y}}z",\n  "c": 1\n}'
    );
  });
});

// Prettier's default quoteProps unquotes an object key that is a bare
// identifier, and a placeholder is one - so a quoted reference in key position
// came back unquoted. Same class of change as stripping quotes in JSON.
describe("beautifyJavaScript keeps quotes on a reference in key position", () => {
  it("keeps the quotes when the key is only a reference", async () => {
    const value = expectValue(
      await beautifyJavaScript('const o = {"{{A.k}}": 1};')
    );
    expect(value).toContain("'{{A.k}}': 1");
  });

  it("keeps the quotes when the key merely contains one", async () => {
    const value = expectValue(
      await beautifyJavaScript('const o = {"pre{{A.k}}": 1};')
    );
    expect(value).toContain("'pre{{A.k}}': 1");
  });

  it("leaves an unquoted key unquoted", async () => {
    const value = expectValue(await beautifyJavaScript("const o = {k: 1};"));
    expect(value).toContain("{ k: 1 }");
  });
});

describe("beautifyJavaScript formats what canBeautifyLanguage advertises", () => {
  it.each([
    ["annotation", "const x: number = 1;"],
    ["interface", "interface A { b: string }\nconst a: A = { b: 'c' };"],
    ["type assertion", "const v = x as string;"],
    ["typed function", "function f(a: string): string { return a; }"],
  ])("formats TypeScript: %s", async (_name, source) => {
    expect(
      expectValue(await beautifyJavaScript(source)).length
    ).toBeGreaterThan(0);
  });
});

describe("a failure message stays a single line", () => {
  it("does not carry Prettier's code frame into the message", async () => {
    const outcome = await beautifyJavaScript(
      "const API_KEY = 'sk-live-ABCDEF123456'; const b = ;"
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.split("\n")).toHaveLength(1);
      expect(outcome.error).not.toContain("sk-live-ABCDEF123456");
      expect(outcome.error).not.toContain("__KH_TPL_");
    }
  });
});

// Formatted JavaScript has to parse. Comparing the `{{...}}` runs on each side
// cannot see this: the reference survives intact while the quotes around it
// break, and re-beautifying hides it, because the second pass masks the
// reference again and the parser never meets the apostrophe.
const AsyncFunction = Object.getPrototypeOf(async () =>
  Promise.resolve()
).constructor;

function expectParses(code: string): void {
  expect(() => new AsyncFunction(code)).not.toThrow();
}

describe("beautifyJavaScript emits JavaScript that parses", () => {
  it.each([
    [
      "apostrophe in a reference, in a string",
      'const m = "Hi {{Bob\'s Check.name}}";',
    ],
    [
      "apostrophe in a reference, as an argument",
      'f({ text: "Owner: {{Dave\'s Node.owner}}" });',
    ],
    ["apostrophe in a reference, as a key", 'const o = {"{{Bob\'s N.k}}": 1};'],
    ["backtick in a reference", 'const m = "x {{Weird `N`.k}} y";'],
    [
      "mixed quotes around a reference",
      'const s = "he said \\"hi\\" {{Bob\'s N.x}}";',
    ],
    ["plain reference in a string", 'const m = "Hi {{Check.name}}";'],
    ["reference in expression position", "const c = {{Setup.result}};"],
  ])("%s", async (_name, source) => {
    const outcome = await beautifyJavaScript(source);
    if (outcome.ok) {
      expectParses(outcome.value.replace(/\{\{[^{}]*\}\}/g, "REF"));
      return;
    }
    // Failing is acceptable; emitting something that will not parse is not.
    expect(outcome.error.length).toBeGreaterThan(0);
  });

  it("formats a block that only looks like a reference", async () => {
    const value = expectValue(
      await beautifyJavaScript("function f() {{ return 1; }}")
    );
    expect(value).toContain("return 1;");
    expectParses(value);
  });
});

// The placeholder prefix has to be absent from the source. Deriving it from a
// non-overlapping scan undercounted `KH_TPL__KH_TPL_`, so the prefix collided
// with the user's own text and a reference was written over it.
describe("the placeholder prefix never collides with the field", () => {
  it.each([
    '{"note":"see KH_TPL__KH_TPL_0__ in docs","to":{{W.address}}}',
    '{"note":"KH_TPL___KH_TPL_0__","to":{{W.address}}}',
    '{"note":"__KH_TPL_0__ and KH_TPL__KH_TPL_1__","to":{{W.address}}}',
  ])("leaves %s alone", (source) => {
    const value = expectValue(beautifyJson(source));
    const stripped = (text: string): string => text.replace(/[ \t\n\r]/g, "");
    expect(stripped(value)).toBe(stripped(source));
  });

  it("does not collide on the JavaScript path either", async () => {
    const source = "const KH_TPL__KH_TPL_0__ = 1;\nconst c = {{A.b}};";
    const value = expectValue(await beautifyJavaScript(source));
    expect(value).toContain("KH_TPL__KH_TPL_0__");
  });
});

describe("a JSON failure does not echo the field back", () => {
  it.each([
    ["a key beside the error", '{"apiKey":"sk-live-SUPERSECRET","b":}'],
    ["a masked reference", "[1,{{My Node.value}},]"],
  ])("%s", (_name, source) => {
    const outcome = beautifyJson(source);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).not.toContain("SUPERSECRET");
      expect(outcome.error).not.toContain("__KH_TPL_");
      expect(outcome.error.split("\n")).toHaveLength(1);
    }
  });
});

// The Monaco fields format the stored value and write it straight back. They
// used to format what the editor displays - `{{Label.field}}`, with the node
// id stripped - and rebuild the stored form afterwards from a label-to-id map.
// That map has one entry per label, so two nodes sharing a display name
// collapsed onto whichever id was seen last, silently repointing a reference
// at a different node. Masking treats each reference as opaque, so the ids
// cannot be confused with each other.
describe("references that differ only by node id stay distinct", () => {
  it("keeps two nodes that share a display label apart", () => {
    const source =
      '{"a":{{@node1:Read Hat.result}},"b":{{@node2:Read Hat.result}}}';
    const value = expectValue(beautifyJson(source));
    expect(value).toContain("{{@node1:Read Hat.result}}");
    expect(value).toContain("{{@node2:Read Hat.result}}");
  });

  it("keeps them apart in JavaScript too", async () => {
    const source =
      "const a = {{@node1:Read Hat.result}};\nconst b = {{@node2:Read Hat.result}};";
    const value = expectValue(await beautifyJavaScript(source));
    expect(value).toContain("{{@node1:Read Hat.result}}");
    expect(value).toContain("{{@node2:Read Hat.result}}");
  });

  it("leaves a reference with no node id bare", () => {
    // Formatting must not resolve a label to a node id that happens to exist.
    const value = expectValue(beautifyJson('{"a":{{Read Hat.result}}}'));
    expect(value).toContain("{{Read Hat.result}}");
    expect(value).not.toContain("@");
  });

  it("keeps a bare and an attached reference to the same label apart", () => {
    const source = '{"a":{{Read Hat.result}},"b":{{@node2:Read Hat.result}}}';
    const value = expectValue(beautifyJson(source));
    expect(value).toContain('"a": {{Read Hat.result}}');
    expect(value).toContain('"b": {{@node2:Read Hat.result}}');
  });
});

// A reference whose body holds a quote is deliberately left unmasked on the
// JavaScript side, because Prettier has to see that quote to choose the
// string's own. It then also escapes it, writing a backslash into the user's
// reference: `{{Bob's N.x}}` came back `{{Bob\'s N.x}}`, which the display
// resolver no longer matches and a node rename no longer rewrites.
//
// The parse-only block below cannot see this - it replaces every reference
// with REF before checking - so the invariant is asserted here instead, on
// the references themselves.
describe("a reference is never altered, even when it cannot be masked", () => {
  const QUOTE_BEARING = [
    ['const s = "he said \\"hi\\" {{Bob\'s N.x}}";', "{{Bob's N.x}}"],
    [
      'const s = "he said \\"hi\\" {{@n1:Bob\'s Check.name}}";',
      "{{@n1:Bob's Check.name}}",
    ],
    ['const m = "Hi {{Bob\'s Check.name}}";', "{{Bob's Check.name}}"],
    ["const m = `x {{Weird `N`.k}} y`;", "{{Weird `N`.k}}"],
  ] as const;

  it.each(QUOTE_BEARING)(
    "refuses rather than rewriting the reference in %s",
    async (source, reference) => {
      const outcome = await beautifyJavaScript(source);
      if (outcome.ok) {
        // Succeeding is fine, as long as the reference came back untouched.
        expect(outcome.value).toContain(reference);
        expect(outcome.value).not.toContain("\\'");
        return;
      }
      expect(outcome.error.length).toBeGreaterThan(0);
    }
  );

  it("says a reference would have changed rather than blaming syntax", async () => {
    const outcome = await beautifyJavaScript(
      'const s = "he said \\"hi\\" {{Bob\'s N.x}}";'
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("reference");
    }
  });

  it("leaves the field alone rather than half-formatting it", async () => {
    const source = 'const a=1;const s = "x \\"y\\" {{Bob\'s N.x}}";';
    const outcome = await beautifyJavaScript(source);
    expect(outcome.ok).toBe(false);
  });
});
