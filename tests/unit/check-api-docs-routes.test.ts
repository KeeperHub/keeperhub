import { describe, expect, it } from "vitest";
import {
  canonicalizeSamplePath,
  parseCodeSampleBlock,
  parseMarkdownEndpoints,
} from "../../scripts/check-api-docs-routes";

const SOURCE = "docs/api/fixture.md";

function page(...lines: string[]): string {
  return lines.join("\n");
}

describe("parseMarkdownEndpoints - http fences", () => {
  it("reads a fenced http block and reports a 1-based line number", () => {
    const text = page("# Keys", "", "```http", "POST /api/keys", "```");

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/keys",
        source: SOURCE,
        line: 4,
        format: "http-fence",
      },
    ]);
  });

  it("drops the query string from a fenced path", () => {
    const text = page("```http", "GET /api/runs?limit=10", "```");

    expect(parseMarkdownEndpoints(text, SOURCE)[0].path).toBe("/api/runs");
  });

  it("skips a fenced declaration marked with the ignore comment", () => {
    // The failure message points every author at this marker, and the
    // http fence is where most declarations live, so the marker has to be
    // read here and not only in prose.
    const text = page(
      "```http",
      "GET /api/legacy/thing <!-- api-docs-ignore -->",
      "POST /api/keys",
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/keys",
        source: SOURCE,
        line: 3,
        format: "http-fence",
      },
    ]);
  });

  it("ignores an http fence written inside an HTML comment", () => {
    const text = page(
      "<!--",
      "```http",
      "GET /api/legacy/thing",
      "```",
      "-->",
      "Call `GET /api/user` for the account."
    );

    expect(parseMarkdownEndpoints(text, SOURCE).map((e) => e.path)).toEqual([
      "/api/user",
    ]);
  });
});

describe("parseMarkdownEndpoints - inline code spans", () => {
  it("reads endpoints out of a markdown table cell", () => {
    const text = page(
      "| Step | Call |",
      "|---|---|",
      "| Sign in | `POST /api/auth/siwe/nonce`, then `POST /api/auth/siwe/verify` |",
      "| Find the wallet | `GET /api/user` -> `walletAddress` |"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/auth/siwe/nonce",
        source: SOURCE,
        line: 3,
        format: "inline-code",
      },
      {
        method: "POST",
        path: "/api/auth/siwe/verify",
        source: SOURCE,
        line: 3,
        format: "inline-code",
      },
      {
        method: "GET",
        path: "/api/user",
        source: SOURCE,
        line: 4,
        format: "inline-code",
      },
    ]);
  });

  it("reads an endpoint out of a prose sentence", () => {
    const text = "Call `POST /api/execute/transfer` with `simulate: true`.";

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/execute/transfer",
        source: SOURCE,
        line: 1,
        format: "inline-code",
      },
    ]);
  });

  it("ignores a docs-site link, which carries a path but no method", () => {
    const text = page(
      "See the [User API](/api/user) reference.",
      "See also [POST /api/keys](/api/keys) for keys."
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores a method and a path that sit in separate code spans", () => {
    const text = "Send `POST` to `/api/keys` to create a key.";

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores an unformatted mention in prose", () => {
    const text = "Older builds answered POST /api/keys/legacy with a 301.";

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores an endpoint quoted inside a json sample", () => {
    // Verbatim from docs/api/index.md. /api/integrations/wallet has no
    // route file, so reading this hint as a declaration would fail CI.
    const text = page(
      "```json",
      "{",
      '  "error": "wallet_not_configured",',
      '  "hint": "POST /api/integrations/wallet to provision a wallet"',
      "}",
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores a code span inside a json fence", () => {
    // The case above is the real docs line, which carries no backticks and
    // so is skipped by the code-span regex whether or not the fence is
    // read. This one only passes because the fence is read.
    const span = '  "hint": "`POST /api/integrations/wallet` to provision"';

    expect(parseMarkdownEndpoints(span, SOURCE)).toHaveLength(1);
    expect(
      parseMarkdownEndpoints(page("```json", span, "```"), SOURCE)
    ).toEqual([]);
  });

  it("ignores a code span inside a tilde fence", () => {
    const text = page(
      "~~~json",
      '  "hint": "`POST /api/integrations/wallet` to provision"',
      "~~~"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("treats a backtick fence inside a tilde block as content", () => {
    // Only the marker that opened a block can close it, so the prose after
    // the inner ``` is still fenced and must not be scanned.
    const text = page(
      "~~~text",
      "```",
      "Call `POST /api/legacy/thing` here.",
      "~~~"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores an endpoint inside an HTML comment", () => {
    const text = "<!-- Call `POST /api/legacy/thing` to do the old thing. -->";

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores an endpoint inside a multi-line HTML comment", () => {
    const text = page(
      "<!--",
      "Call `POST /api/legacy/thing` to do the old thing.",
      "-->",
      "Call `GET /api/user` for the account."
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "GET",
        path: "/api/user",
        source: SOURCE,
        line: 4,
        format: "inline-code",
      },
    ]);
  });

  it("skips a line marked with the ignore comment", () => {
    // Documenting a removal is a normal thing to want to do, and the
    // marker renders as nothing on the docs site.
    const text = page(
      "Deprecated: `POST /api/legacy/thing` was removed in v2. <!-- api-docs-ignore -->",
      "Use `GET /api/user` instead."
    );

    expect(parseMarkdownEndpoints(text, SOURCE).map((e) => e.path)).toEqual([
      "/api/user",
    ]);
  });

  it("keeps a declaration that sits behind a marker written mid-line", () => {
    // The marker skips the line it ends, so a marker written anywhere
    // else is not one - taking the rest of the line with it would drop a
    // real declaration on the author's behalf.
    const text = "<!-- api-docs-ignore --> and also `GET /api/user`";

    expect(parseMarkdownEndpoints(text, SOURCE).map((e) => e.path)).toEqual([
      "/api/user",
    ]);
  });
});

describe("parseMarkdownEndpoints - code samples", () => {
  it("infers the method from the helper name, and reads a sample once", () => {
    // The comment holds a code span, which outside a fence would be read
    // as a second declaration of the same endpoint.
    const text = page(
      "```ts",
      "// `POST /api/keys` answers the first call with a challenge",
      'const key = await post("/api/keys", { name: "ci" });',
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/keys",
        source: SOURCE,
        line: 3,
        format: "code-sample",
      },
    ]);
  });

  it("infers the method from a method option when the helper is neutral", () => {
    const text = page(
      "```ts",
      'const res = await fetch("/api/execute/transfer", {',
      '  method: "POST",',
      "  headers,",
      "});",
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/execute/transfer",
        source: SOURCE,
        line: 2,
        format: "code-sample",
      },
    ]);
  });

  it("falls back to GET when neither the helper nor the options name a method", () => {
    const text = page("```ts", 'const me = await api("/api/user");', "```");

    expect(parseMarkdownEndpoints(text, SOURCE)[0].method).toBe("GET");
  });

  it("names the path parameter after the last identifier of a template hole", () => {
    const text = page(
      "```ts",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the markdown fixture's content, not this file's
      "const status = await api(`/api/execute/${exec.executionId}/status`);",
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)[0].path).toBe(
      "/api/execute/{executionId}/status"
    );
  });

  it("reads js fences as well as ts fences", () => {
    const text = page("```js", 'await del("/api/keys/{keyId}");', "```");

    expect(parseMarkdownEndpoints(text, SOURCE)[0].method).toBe("DELETE");
  });

  it("leaves a URL assembled from variables alone", () => {
    const text = page("```ts", "await fetch(BASE + path, { headers });", "```");

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("lets an explicit method beat the verb in the helper name", () => {
    // The helper name is an inference; `method:` is what gets sent.
    const text = page(
      "```ts",
      'await get("/api/keys", { method: "POST" });',
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)[0].method).toBe("POST");
  });

  it("does not read a path out of a call that is not a request", () => {
    // app/api/user/wallet/withdraw/route.ts exports POST only, so reading
    // either of these as a GET would fail the gate on a correct page.
    const text = page(
      "```ts",
      'const url = new URL("/api/user/wallet/withdraw", BASE);',
      'console.log("/api/keys");',
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores a code sample written inside an HTML comment", () => {
    // Same class as the commented-out prose case: it renders as nothing
    // on the docs site, so it must not gate CI either.
    const text = page(
      "<!--",
      "```ts",
      'await api("/api/legacy/thing");',
      "```",
      "-->"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("skips a marked call without shifting the lines reported after it", () => {
    const text = page(
      "```ts",
      'await api("/api/legacy/thing"); // <!-- api-docs-ignore -->',
      'await api("/api/user");',
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "GET",
        path: "/api/user",
        source: SOURCE,
        line: 3,
        format: "code-sample",
      },
    ]);
  });
});

describe("parseCodeSampleBlock", () => {
  it("offsets line numbers by the opening fence line", () => {
    const block = page("const a = 1;", 'await post("/api/keys");');

    expect(parseCodeSampleBlock(block, 10, SOURCE)[0].line).toBe(12);
  });

  it("does not carry one call's method over to the next call", () => {
    // The unclosed paren in the comment means the first call's argument
    // span never balances; without a ceiling it would run on into the
    // second call and pick up its method.
    const block = page(
      'const me = await api("/api/user", {',
      "  // the wrapper adds Authorization (and the org header",
      "  headers,",
      "});",
      'const key = await api("/api/keys", { method: "POST" });'
    );

    expect(
      parseCodeSampleBlock(block, 1, SOURCE).map((endpoint) => [
        endpoint.method,
        endpoint.path,
      ])
    ).toEqual([
      ["GET", "/api/user"],
      ["POST", "/api/keys"],
    ]);
  });

  it("is not confused by a paren inside a string argument", () => {
    const block = 'await api("/api/keys", { name: "ci (prod)" });';

    expect(parseCodeSampleBlock(block, 1, SOURCE)).toHaveLength(1);
  });
});

describe("canonicalizeSamplePath", () => {
  it("turns a template hole into a named parameter", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the docs sample's content, not this file's
    expect(canonicalizeSamplePath("/api/runs/${run.id}")).toBe(
      "/api/runs/{id}"
    );
  });

  it("strips the query string and a trailing slash", () => {
    expect(canonicalizeSamplePath("/api/runs/?limit=10")).toBe("/api/runs");
  });

  it("rejects a literal that is not shaped like a route", () => {
    expect(canonicalizeSamplePath("/api/keys - the key endpoint")).toBeNull();
  });

  it("does not name a computed hole after its last identifier", () => {
    // `{b}` would read like a parameter the API has. The artifact string
    // is what the post-deploy probe reports on.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the docs sample's content, not this file's
    expect(canonicalizeSamplePath("/api/workflows/${a + b}")).toBe(
      "/api/workflows/{param}"
    );
  });
});
