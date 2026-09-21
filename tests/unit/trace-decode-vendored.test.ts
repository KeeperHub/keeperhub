import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The vendored trace matcher must not drift from this app's own copy.
 *
 * `keeperhub-events/event-tracker/lib/web3/trace-decode.ts` is a copy of
 * `lib/web3/trace-decode.ts`, because the tracker is a separate pnpm
 * workspace whose Docker build context is `keeperhub-events/` and therefore
 * does not contain the app's `lib/` at all. A copy with nothing holding it in
 * place is how the two versions diverged before: one side grew the
 * `DECODABLE_CALL_TYPES` guard on `callSelector` and the "surface an
 * unparseable value" decision, the other did not, and a `selector` filter
 * fired on a contract deployment as a result.
 *
 * WHY THIS TEST IS AT THE ROOT AND NOT IN THE TRACKER'S OWN SUITE.
 *
 * It was in the tracker's suite, and that made the guard one-way.
 * `.github/workflows/pr-checks-events.yml` is path-filtered to
 * `keeperhub-events/**`, and no other workflow runs the tracker's unit tests,
 * so a pull request editing only the file in THIS directory never ran it -
 * exactly half of what it exists to catch.
 * `.github/workflows/pr-checks.yml` declares `on: pull_request:
 * branches: ['**']` with no `paths` filter, so its `test-unit` job runs on
 * every pull request and an edit to either copy reaches this assertion.
 *
 * Keep it here. Moving it under `keeperhub-events/` restores the hole.
 *
 * Each block the copy took is marked in the vendored file. This reads both
 * files and checks every marked block still appears in the original, with
 * comments, whitespace, `export` keywords and trailing commas normalised away,
 * so the two workspaces' different biome configs are not a false alarm and a
 * real edit to either side is.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGINAL = resolve(HERE, "../../lib/web3/trace-decode.ts");
const VENDORED = resolve(
  HERE,
  "../../keeperhub-events/event-tracker/lib/web3/trace-decode.ts"
);
const MARKER = "// --- copied from lib/web3/trace-decode.ts ---";

/**
 * Comments, formatting and `export` carry no behaviour, and the two
 * workspaces lint with different biome configs, so compare what is left.
 */
function normalise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\bexport\s+/g, "")
    .replace(/\s+/g, "")
    .replace(/,(?=[)\]}])/g, "");
}

describe("the vendored trace matcher", () => {
  const vendored = readFileSync(VENDORED, "utf8");
  const original = normalise(readFileSync(ORIGINAL, "utf8"));

  const blocks = vendored
    .split(MARKER)
    .slice(1)
    .map((block) => normalise(block))
    .filter((block) => block.length > 0);

  it("marks the blocks it copied", () => {
    // A copy with no markers would make every case below vacuously pass.
    expect(blocks.length).toBe(4);
  });

  it.each([0, 1, 2, 3])(
    "keeps copied block %i identical to lib/web3/trace-decode.ts",
    (index) => {
      expect(original).toContain(blocks[index]);
    }
  );

  it("names every declaration the tracker imports", () => {
    // Anything the tracker uses that is not inside a marked block is not
    // covered by the check above, so it would be free to drift.
    for (const name of [
      "RawCallFrame",
      "FlatCall",
      "DECODABLE_CALL_TYPES",
      "flattenCallTree",
      "TraceCallFilter",
      "callSelector",
      "frameValueWei",
      "frameMatches",
    ]) {
      expect(blocks.join("")).toContain(name);
    }
  });
});
