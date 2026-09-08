// The kh CLI compares its own build against KH-Minimum-CLI-Version on every
// response and warns when it is older (internal/http/version.go). That client
// check shipped long ago but nothing ever sent the header, so it was inert.
// Since `kh update` is manual and unprompted, this warning is the only signal
// an out-of-date CLI gets - these tests pin the contract it depends on.

import { describe, expect, it } from "vitest";

import {
  CLI_VERSION_HEADER_RULE,
  MINIMUM_CLI_VERSION,
  MINIMUM_CLI_VERSION_HEADER,
} from "@/lib/cli-version";

describe("minimum CLI version header", () => {
  it("uses the exact header name the CLI reads", () => {
    // internal/http/version.go does resp.Header.Get("KH-Minimum-CLI-Version"),
    // so any drift in this string silently disables the warning.
    expect(MINIMUM_CLI_VERSION_HEADER).toBe("KH-Minimum-CLI-Version");
  });

  it("floors above the last release with a broken device login", () => {
    // 0.11.0 is the last release whose device login could not work, so the
    // floor has to sort above it for those users to be warned.
    expect(MINIMUM_CLI_VERSION).toBe("0.11.1");
  });

  it("advertises the floor on API routes, where the CLI talks", () => {
    expect(CLI_VERSION_HEADER_RULE.source).toBe("/api/:path*");
    expect(CLI_VERSION_HEADER_RULE.headers).toContainEqual({
      key: MINIMUM_CLI_VERSION_HEADER,
      value: MINIMUM_CLI_VERSION,
    });
  });

  it("is wired into next.config's headers()", async () => {
    // next.config's default export is wrapped by withSentryConfig/withWorkflow
    // and exposes no callable headers(), so assert on the source text: the rule
    // must actually be referenced, not merely defined.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../next.config.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("CLI_VERSION_HEADER_RULE");
    expect(source).toContain('from "./lib/cli-version"');
  });
});
