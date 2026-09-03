/**
 * Guards the build-time contract that makes `start(executeWorkflow)` work.
 *
 * A "use workflow" function is only compiled into a real workflow if
 * @workflow/builders' `detectWorkflowPatterns` finds its directive - that is
 * what gates the Next.js loader, and an undetected file ships as a plain
 * function whose `workflowId` is undefined. `start()` then throws
 * "'start' received an invalid workflow function" at runtime, in production,
 * with nothing failing at build time.
 *
 * KEEP-1302 was exactly that. The detector blanks template literals with a
 * regex that pairs backticks positionally, ignoring string context, so a
 * single backtick inside an ordinary quoted string left the file's ticks
 * unpaired, desynchronized the matcher for everything after it, and blanked
 * the directive itself.
 *
 * Entrypoints are discovered rather than listed, so a new *.workflow.ts is
 * covered the day it lands instead of the day someone remembers this file.
 */
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";
// `@workflow/builders` is a transitive dependency, resolvable here only
// because .npmrc public-hoists `@workflow/*`. That is deliberate (see the
// comment on public-hoist-pattern), and if it ever stops resolving this test
// goes red rather than quietly passing, which is the safe direction.
import { detectWorkflowPatterns } from "@workflow/builders";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = process.cwd();

/**
 * Files the Next.js loader must transform. The `*.workflow.ts` suffix is the
 * repo's convention for a workflow entrypoint; codegen templates that merely
 * emit a directive inside a template string do not use it, and must not be
 * asserted on - the detector is right to skip those.
 */
let entrypoints: string[] = [];

beforeAll(async () => {
  const found: string[] = [];
  for await (const path of glob("**/*.workflow.ts", {
    cwd: repoRoot,
    exclude: (name) => name === "node_modules" || name === ".next",
  })) {
    found.push(path);
  }
  entrypoints = found.sort();
});

describe("workflow directive detection", () => {
  it("finds at least one workflow entrypoint to check", () => {
    // Guards the discovery itself: a glob that silently matches nothing would
    // make every assertion below vacuous.
    expect(entrypoints.length).toBeGreaterThan(0);
  });

  it("sees every entrypoint as a workflow", () => {
    const undetected = entrypoints.filter(
      (path) =>
        !detectWorkflowPatterns(readFileSync(join(repoRoot, path), "utf8"))
          .hasUseWorkflow
    );

    expect(undetected).toEqual([]);
  });

  it("keeps entrypoint backticks paired, which the detector's regex requires", () => {
    // An odd count means some backtick sits in a comment or a quoted string.
    // The detector pairs them positionally, so one stray tick silently blanks
    // real code - including the directive - from there to end of file.
    const unpaired = entrypoints.filter((path) => {
      const source = readFileSync(join(repoRoot, path), "utf8");
      return (source.match(/`/g) ?? []).length % 2 !== 0;
    });

    expect(unpaired).toEqual([]);
  });
});
