import { describe, expect, it } from "vitest";
import { toDocsRelativePath } from "../../docs-site/lib/docs-file-path";

// docs-site is a standalone pnpm project with no test runner of its own, and
// the root tsconfig excludes it. Keeping this test in the root tree is what
// gets it both executed (root vitest) and type-checked (root tsc), and it
// keeps the vitest import out of docs-site, whose tsc cannot resolve it.

describe("toDocsRelativePath", () => {
  it("strips the resolved-symlink prefix emitted by non-Docker builds", () => {
    expect(toDocsRelativePath("../docs/api/errors.md")).toBe("api/errors.md");
    expect(toDocsRelativePath("../docs/FAQ.md")).toBe("FAQ.md");
  });

  it("strips the content prefix emitted by the Docker image build", () => {
    expect(toDocsRelativePath("content/api/errors.md")).toBe("api/errors.md");
    expect(toDocsRelativePath("content/index.md")).toBe("index.md");
  });

  it("strips Nextra's src/content root", () => {
    expect(toDocsRelativePath("src/content/api/errors.md")).toBe(
      "api/errors.md"
    );
  });

  it("produces the same result for every layout of the same page", () => {
    const shapes = [
      "../docs/guides/gelato-migration.md",
      "content/guides/gelato-migration.md",
      "src/content/guides/gelato-migration.md",
    ];
    const results = new Set(shapes.map(toDocsRelativePath));
    expect(results).toEqual(new Set(["guides/gelato-migration.md"]));
  });

  it("leaves a path with no recognised content root unchanged", () => {
    expect(toDocsRelativePath("api/errors.md")).toBe("api/errors.md");
  });

  it("does not strip a directory that merely starts with a root name", () => {
    expect(toDocsRelativePath("contents/api.md")).toBe("contents/api.md");
    expect(toDocsRelativePath("documentation/api.md")).toBe(
      "documentation/api.md"
    );
  });
});
