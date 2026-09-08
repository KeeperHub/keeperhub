/**
 * KEEP-468 / KEEP-525: regression tests for the strict template resolution
 * path. Strict is now the only mode; the legacy env-var opt-out was removed.
 *
 * Coverage:
 *   - tracker collects each unresolved category (no-node, no-data, no-path)
 *     when callers thread it through processTemplate / processTemplates
 *     / processCodeTemplates / extractTemplateParameters
 *   - assertResolved always throws TemplateResolutionError on any unresolved
 *     reference
 *   - the displayPattern literal-passthrough is detected by the post-scan
 *     even when the resolver returned a plain string with `{{...}}` left in
 *
 * The hackathon scenario that motivated KEEP-468 is exercised end-to-end:
 * the literal `{{$trigger.input.ts}}` (n8n syntax, not the KH grammar) must
 * not flow through to a downstream action.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { processTemplate } from "@/lib/utils/template";
import {
  extractTemplateParameters,
  processCodeTemplates,
  processTemplates,
} from "@/lib/workflow/executor/executor.workflow";
import {
  assertResolved,
  createTracker,
  TemplateResolutionError,
} from "@/lib/workflow/executor/template-resolution";

const UNRESOLVED_REF_MESSAGE = /Unresolved template reference/;

const baseOutputs = {
  trigger: {
    label: "Trigger",
    data: { triggered: true, ts: 1_715_000_000 },
  },
};

describe("processTemplate tracker (lib/utils/template)", () => {
  it("records no-node when the referenced node is absent", () => {
    const tracker = createTracker();
    const out = processTemplate(
      "{{@missing:Label.field}}",
      baseOutputs,
      tracker
    );
    expect(out).toBe("");
    expect(tracker.unresolved).toHaveLength(1);
    expect(tracker.unresolved[0]?.reason).toBe("no-node");
  });

  it("records no-path when the field is missing on a present node", () => {
    const tracker = createTracker();
    const out = processTemplate(
      "{{@trigger:Trigger.does.not.exist}}",
      baseOutputs,
      tracker
    );
    expect(out).toBe("");
    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });

  it("does not record when the reference resolves cleanly", () => {
    const tracker = createTracker();
    const out = processTemplate(
      "{{@trigger:Trigger.ts}}",
      baseOutputs,
      tracker
    );
    expect(out).toBe("1715000000");
    expect(tracker.unresolved).toHaveLength(0);
  });
});

describe("assertResolved (executor strict gate)", () => {
  it("throws TemplateResolutionError in strict mode (default)", () => {
    const tracker = createTracker();
    tracker.unresolved.push({
      token: "{{$trigger.input.ts}}",
      reason: "no-node",
      detail: "n8n-style syntax not supported",
    });
    expect(() =>
      assertResolved(tracker, { value: "" }, { actionType: "Webhook" })
    ).toThrow(TemplateResolutionError);
  });

  it("detects displayPattern literal pass-through in strict mode", () => {
    const tracker = createTracker();
    expect(() =>
      assertResolved(
        tracker,
        { value: "Address: {{Trigger.unknownField}}" },
        { actionType: "ENS Write" }
      )
    ).toThrow(TemplateResolutionError);
  });

  it("flags the original Tradewise hackathon corruption case", () => {
    // Simulates the exact corruption: an n8n-style ref leaked into a string
    // value bound to an on-chain ENS write.
    const tracker = createTracker();
    const renderedConfig = {
      key: "site",
      value: "{{$trigger.input.ts}}",
    };
    expect(() =>
      assertResolved(tracker, renderedConfig, { actionType: "ENS Write" })
    ).toThrow(UNRESOLVED_REF_MESSAGE);
  });
});

describe("processTemplates strict integration", () => {
  it("flags display-format references that fall through to literal pass-through", () => {
    const tracker = createTracker();
    const result = processTemplates(
      { url: "https://api/{{Trigger.unknownField}}" },
      baseOutputs,
      tracker
    );
    // The historical behaviour leaves the literal in the rendered string.
    expect(result.url).toContain("{{Trigger.unknownField}}");
    expect(tracker.unresolved.some((u) => u.reason === "no-path")).toBe(true);
  });

  it("does not record when references resolve", () => {
    const tracker = createTracker();
    processTemplates({ ts: "{{@trigger:Trigger.ts}}" }, baseOutputs, tracker);
    expect(tracker.unresolved).toHaveLength(0);
  });
});

describe("processCodeTemplates strict integration", () => {
  it("records no-node and leaves the original token in the code (caught by post-scan)", () => {
    const tracker = createTracker();
    const out = processCodeTemplates(
      "const x = {{@missing:Foo.bar}};",
      baseOutputs,
      tracker
    );
    expect(out).toContain("{{@missing:Foo.bar}}");
    expect(tracker.unresolved[0]?.reason).toBe("no-node");
  });

  it("records no-data when the upstream node returned null", () => {
    const tracker = createTracker();
    const outputs = {
      upstream: { label: "Upstream", data: null },
    };
    const out = processCodeTemplates(
      "const x = {{@upstream:Upstream.value}};",
      outputs,
      tracker
    );
    expect(out).toContain("null");
    expect(tracker.unresolved[0]?.reason).toBe("no-data");
  });
});

describe("present-but-empty field paths resolve instead of failing", () => {
  const nullableOutputs = {
    trigger: {
      label: "Trigger",
      data: { ts: null, note: undefined, nested: { inner: null } },
    },
  };

  it("resolves a key that exists holding null to the empty string", () => {
    const tracker = createTracker();
    const result = processTemplates(
      { ts: "{{@trigger:Trigger.ts}}" },
      nullableOutputs,
      tracker
    );
    expect(result.ts).toBe("");
    expect(tracker.unresolved).toHaveLength(0);
  });

  it("resolves a key that exists holding undefined", () => {
    const tracker = createTracker();
    const result = processTemplates(
      { note: "{{@trigger:Trigger.note}}" },
      nullableOutputs,
      tracker
    );
    expect(result.note).toBe("");
    expect(tracker.unresolved).toHaveLength(0);
  });

  it("resolves a nested key that exists holding null", () => {
    const tracker = createTracker();
    const result = processTemplates(
      { inner: "{{@trigger:Trigger.nested.inner}}" },
      nullableOutputs,
      tracker
    );
    expect(result.inner).toBe("");
    expect(tracker.unresolved).toHaveLength(0);
  });

  it("still records no-path when the key is genuinely absent", () => {
    const tracker = createTracker();
    processTemplates(
      { missing: "{{@trigger:Trigger.notAKey}}" },
      nullableOutputs,
      tracker
    );
    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });

  it("renders a present null as the null literal in code nodes", () => {
    const tracker = createTracker();
    const out = processCodeTemplates(
      "const x = {{@trigger:Trigger.ts}};",
      nullableOutputs,
      tracker
    );
    expect(out).toBe("const x = null;");
    expect(tracker.unresolved).toHaveLength(0);
  });

  it("still records no-path in code nodes when the key is absent", () => {
    const tracker = createTracker();
    processCodeTemplates(
      "const x = {{@trigger:Trigger.notAKey}};",
      nullableOutputs,
      tracker
    );
    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });
});

describe("processCodeTemplates: refs in comments are documentation, not deps", () => {
  const codeOutputs = {
    src: { label: "Src", data: { value: 42, addr: "0xabc" } },
    "50CDD": {
      label: "Check past lift events",
      data: { events: [{ whom: "0xspell" }] },
    },
  };

  it("ignores a ref in a // line comment", () => {
    const tracker = createTracker();
    const code = "// example: {{@missing:Foo.bar}}\nconst x = 1;";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toBe(code);
    expect(tracker.unresolved).toEqual([]);
  });

  it("ignores a ref in a /* */ block comment", () => {
    const tracker = createTracker();
    const code = "/* see {{@missing:Foo.bar}} */\nconst x = 1;";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toBe(code);
    expect(tracker.unresolved).toEqual([]);
  });

  it("ignores a ref in a /** */ JSDoc comment", () => {
    const tracker = createTracker();
    const code = "/**\n * @example {{@missing:Foo.bar}}\n */\nconst x = 1;";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toBe(code);
    expect(tracker.unresolved).toEqual([]);
  });

  it("ignores a ref in commented-out code", () => {
    const tracker = createTracker();
    const code = "// const old = {{@missing:Foo.bar}};\nconst x = 1;";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toBe(code);
    expect(tracker.unresolved).toEqual([]);
  });

  it("ignores a trailing inline // comment ref but resolves the code ref before it", () => {
    const tracker = createTracker();
    const code = "const x = {{@src:Src.value}}; // and {{@missing:Foo.bar}}";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toBe("const x = 42; // and {{@missing:Foo.bar}}");
    expect(tracker.unresolved).toEqual([]);
  });

  it("ignores refs spread across a multi-line block comment", () => {
    const tracker = createTracker();
    const code =
      "/*\n {{@a:A.b}}\n {{@c:C.d}}\n*/\nconst x = {{@src:Src.value}};";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toContain("{{@a:A.b}}");
    expect(out).toContain("{{@c:C.d}}");
    expect(out).toContain("const x = 42;");
    expect(tracker.unresolved).toEqual([]);
  });

  it("resolves a ref inside a string literal (a string is not a comment)", () => {
    const tracker = createTracker();
    const code = 'const s = "{{@src:Src.value}}";';
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).not.toContain("{{");
    expect(tracker.unresolved).toEqual([]);
  });

  it("does not treat // inside a string literal as a comment", () => {
    const tracker = createTracker();
    const code = 'const url = "http://{{@src:Src.value}}";';
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).not.toContain("{{");
    expect(out).toContain("42");
    expect(tracker.unresolved).toEqual([]);
  });

  it("still flags a genuine unresolved ref in executable code, with the line number", () => {
    const tracker = createTracker();
    const code = "const a = 1;\nconst b = {{@missing:Foo.bar}};";
    processCodeTemplates(code, codeOutputs, tracker);
    expect(tracker.unresolved).toHaveLength(1);
    expect(tracker.unresolved[0]?.reason).toBe("no-node");
    expect(tracker.unresolved[0]?.detail).toContain("line 2");
  });

  it("the Chief Keeper Filter case: example refs in comments do not fail the node", () => {
    const tracker = createTracker();
    const code = [
      "// Use @ to insert template variables from upstream nodes",
      "// e.g. {{QueryEvents.events}}, {{ReadContract.result}}",
      "",
      "const data = {{@50CDD:Check past lift events.events}};",
      "return data.length;",
    ].join("\n");
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(tracker.unresolved).toEqual([]);
    expect(out).toContain('const data = [{"whom":"0xspell"}];');
    expect(out).toContain("{{QueryEvents.events}}");
  });

  // Data-driven: every comment style x both ref forms (stored + display) must
  // be left untouched and never recorded as unresolved.
  const COMMENT_WRAPPERS: Array<{
    name: string;
    wrap: (ref: string) => string;
  }> = [
    { name: "// line comment", wrap: (r) => `// ${r}\nconst x = 1;` },
    { name: "/* block */ comment", wrap: (r) => `/* ${r} */\nconst x = 1;` },
    {
      name: "/** jsdoc */ comment",
      wrap: (r) => `/**\n * @example ${r}\n */\nconst x = 1;`,
    },
    { name: "trailing inline // comment", wrap: (r) => `const x = 1; // ${r}` },
    {
      name: "commented-out code",
      wrap: (r) => `// const old = ${r};\nconst x = 1;`,
    },
  ];
  const REF_FORMS = [
    "{{@missing:Foo.bar}}", // stored form, unknown node
    "{{@src:Src.value}}", // stored form, KNOWN node (must still be skipped in a comment)
    "{{QueryEvents.events}}", // display form, unknown node
  ];
  for (const wrapper of COMMENT_WRAPPERS) {
    for (const ref of REF_FORMS) {
      it(`does not resolve ${ref} inside ${wrapper.name}`, () => {
        const tracker = createTracker();
        const code = wrapper.wrap(ref);
        const out = processCodeTemplates(code, codeOutputs, tracker);
        expect(out).toContain(ref);
        expect(out).not.toContain("42");
        expect(tracker.unresolved).toEqual([]);
      });
    }
  }

  it("handles arbitrary interleaving of real code, comments, and commented-out code", () => {
    const tracker = createTracker();
    const code = [
      "const a = {{@src:Src.value}};", // real -> 42
      "// commented {{@x:X.y}} ref", // comment -> skip
      "const b = {{@src:Src.addr}};", // real -> "0xabc"
      "/* block {{@p:P.q}}", // block comment -> skip
      "   still {{@r:R.s}} comment", // block comment -> skip
      "*/",
      "const c = {{@50CDD:Check past lift events.events}}; // trailing {{@t:T.u}}", // real + trailing skip
      "// const old = {{@src:Src.value}};", // commented-out real-looking ref -> skip
      "/** @example {{ReadContract.result}} */", // jsdoc display -> skip
      "return [a, b, c];",
    ].join("\n");
    const out = processCodeTemplates(code, codeOutputs, tracker);

    expect(tracker.unresolved).toEqual([]);
    expect(out).toContain("const a = 42;");
    expect(out).toContain('const b = "0xabc";');
    expect(out).toContain('const c = [{"whom":"0xspell"}];');
    for (const left of [
      "{{@x:X.y}}",
      "{{@p:P.q}}",
      "{{@r:R.s}}",
      "{{@t:T.u}}",
      "// const old = {{@src:Src.value}};",
      "{{ReadContract.result}}",
    ]) {
      expect(out).toContain(left);
    }
  });

  it("resolves multiple real refs across many lines while skipping interleaved comment refs", () => {
    const tracker = createTracker();
    const code = [
      "/* header {{@h:H.i}} */",
      "const a = {{@src:Src.value}};",
      "const b = {{@src:Src.value}}; // {{@c1:C.1}}",
      "// {{@c2:C.2}}",
      "const c = {{@src:Src.addr}};",
    ].join("\n");
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(tracker.unresolved).toEqual([]);
    expect((out.match(/42/g) ?? []).length).toBe(2);
    expect(out).toContain('"0xabc"');
    for (const left of ["{{@h:H.i}}", "{{@c1:C.1}}", "{{@c2:C.2}}"]) {
      expect(out).toContain(left);
    }
  });

  it("flags every genuine unresolved ref with its line number, ignoring comment refs", () => {
    const tracker = createTracker();
    const code = [
      "// comment {{@inComment:A.b}}", // line 1 - skip
      "const a = {{@missing1:Foo.bar}};", // line 2 - flag
      "const b = 2;", // line 3
      "/* {{@inBlock:C.d}} */", // line 4 - skip
      "const e = {{@missing2:Baz.qux}};", // line 5 - flag
    ].join("\n");
    processCodeTemplates(code, codeOutputs, tracker);
    const details = tracker.unresolved.map((u) => u.detail ?? "");
    expect(tracker.unresolved).toHaveLength(2);
    expect(details.some((d) => d.includes("line 2"))).toBe(true);
    expect(details.some((d) => d.includes("line 5"))).toBe(true);
    expect(details.some((d) => d.includes("inComment"))).toBe(false);
    expect(details.some((d) => d.includes("inBlock"))).toBe(false);
  });

  it("resolves a real ref on the same line right after a block comment closes", () => {
    const tracker = createTracker();
    const code = "/* {{@a:A.b}} */ const v = {{@src:Src.value}};";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toBe("/* {{@a:A.b}} */ const v = 42;");
    expect(tracker.unresolved).toEqual([]);
  });

  it("leaves code that is only comments untouched", () => {
    const tracker = createTracker();
    const code = "// {{@a:A.b}}\n/* {{@c:C.d}} */\n/** {{Display.ref}} */";
    const out = processCodeTemplates(code, codeOutputs, tracker);
    expect(out).toBe(code);
    expect(tracker.unresolved).toEqual([]);
  });

  // Comment detection is structure-agnostic (it scans tokens, not syntax), so
  // refs in comments inside any control-flow structure must be skipped while
  // real refs in the same structure resolve. `{{@src:Src.value}}` is the one
  // real ref (-> 42); every other token lives in a comment and must survive.
  const structureCase = (name: string, code: string): void => {
    it(name, () => {
      const tracker = createTracker();
      const out = processCodeTemplates(code, codeOutputs, tracker);
      expect(tracker.unresolved).toEqual([]);
      expect(out).toContain("42");
      for (const m of code.matchAll(/\{\{[^}]+\}\}/g)) {
        const token = m[0];
        if (token !== "{{@src:Src.value}}") {
          expect(out).toContain(token);
        }
      }
    });
  };

  structureCase(
    "if / else if / else",
    [
      "if (a) {",
      "  // {{@c1:C.1}}",
      "  const x = {{@src:Src.value}};",
      "} else if (b) {",
      "  /* {{@c2:C.2}} */",
      "} else {",
      "  // fallback {{@c3:C.3}}",
      "}",
    ].join("\n")
  );

  structureCase(
    "switch / case",
    [
      "switch (k) {",
      "  case 1: // {{@c1:C.1}}",
      "    return {{@src:Src.value}};",
      "  /* {{@c2:C.2}} */",
      "  default:",
      "    // {{@c3:C.3}}",
      "    break;",
      "}",
    ].join("\n")
  );

  structureCase(
    "for loop",
    [
      "for (let i = 0; i < n; i++) {",
      "  // iterate {{@c1:C.1}}",
      "  total += {{@src:Src.value}};",
      "  /* {{@c2:C.2}} */",
      "}",
    ].join("\n")
  );

  structureCase(
    "while loop",
    [
      "while (cond) {",
      "  // {{@c1:C.1}}",
      "  x = {{@src:Src.value}};",
      "}",
    ].join("\n")
  );

  structureCase(
    "try / catch / finally",
    [
      "try {",
      "  // {{@c1:C.1}}",
      "  v = {{@src:Src.value}};",
      "} catch (e) {",
      "  /* {{@c2:C.2}} */",
      "} finally {",
      "  // {{@c3:C.3}}",
      "}",
    ].join("\n")
  );

  structureCase(
    "function + arrow function bodies",
    [
      "function f() {",
      "  // {{@c1:C.1}}",
      "  return {{@src:Src.value}};",
      "}",
      "const g = () => {",
      "  /* {{@c2:C.2}} */",
      "};",
    ].join("\n")
  );

  structureCase(
    "nested structures (for inside if inside switch) with interleaved comments",
    [
      "switch (k) {",
      "  case 1:",
      "    if (a) {",
      "      // {{@c1:C.1}}",
      "      for (const it of items) {",
      "        /* {{@c2:C.2}}",
      "           {{@c3:C.3}} */",
      "        acc += {{@src:Src.value}};",
      "      }",
      "    }",
      "    break;",
      "}",
    ].join("\n")
  );

  structureCase(
    "do / while loop",
    [
      "do {",
      "  // {{@c1:C.1}}",
      "  x = {{@src:Src.value}};",
      "} while (cond); /* {{@c2:C.2}} */",
    ].join("\n")
  );

  structureCase(
    "for...of loop",
    [
      "for (const item of items) {",
      "  // {{@c1:C.1}}",
      "  sum += {{@src:Src.value}};",
      "}",
    ].join("\n")
  );

  structureCase(
    "for...in loop",
    [
      "for (const key in obj) {",
      "  /* {{@c1:C.1}} */",
      "  total = {{@src:Src.value}};",
      "}",
    ].join("\n")
  );

  structureCase(
    "ternary expression",
    [
      "const v = cond",
      "  ? {{@src:Src.value}} // {{@c1:C.1}}",
      "  : 0; /* {{@c2:C.2}} */",
    ].join("\n")
  );

  structureCase(
    "object literal",
    [
      "const o = {",
      "  // {{@c1:C.1}}",
      "  amount: {{@src:Src.value}},",
      "  /* {{@c2:C.2}} */",
      "};",
    ].join("\n")
  );

  structureCase(
    "array literal",
    [
      "const arr = [",
      "  // {{@c1:C.1}}",
      "  {{@src:Src.value}},",
      "  /* {{@c2:C.2}} */",
      "];",
    ].join("\n")
  );

  structureCase(
    "class declaration with method",
    [
      "class C {",
      "  // {{@c1:C.1}}",
      "  m() {",
      "    /* {{@c2:C.2}} */",
      "    return {{@src:Src.value}};",
      "  }",
      "}",
    ].join("\n")
  );

  structureCase(
    "async / await function",
    [
      "async function run() {",
      "  // {{@c1:C.1}}",
      "  await tick();",
      "  return {{@src:Src.value}}; /* {{@c2:C.2}} */",
      "}",
    ].join("\n")
  );

  structureCase(
    "generator function",
    [
      "function* gen() {",
      "  // {{@c1:C.1}}",
      "  yield {{@src:Src.value}};",
      "}",
    ].join("\n")
  );

  structureCase(
    "IIFE",
    [
      "(function () {",
      "  /* {{@c1:C.1}} */",
      "  return {{@src:Src.value}};",
      "})(); // {{@c2:C.2}}",
    ].join("\n")
  );

  structureCase(
    "labeled loop with break",
    [
      "outer: for (;;) {",
      "  // {{@c1:C.1}}",
      "  x = {{@src:Src.value}};",
      "  break outer; /* {{@c2:C.2}} */",
      "}",
    ].join("\n")
  );
});

describe("extractTemplateParameters strict integration", () => {
  it("records no-path when a referenced field does not resolve", () => {
    const tracker = createTracker();
    const { paramValues } = extractTemplateParameters(
      "SELECT * FROM t WHERE id = {{@trigger:Trigger.missing}}",
      baseOutputs,
      tracker
    );
    expect(paramValues).toEqual([null]);
    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });
});
