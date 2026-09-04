#!/usr/bin/env node
/**
 * Emits a Markdown representation of every docs page into `public/_md/`.
 *
 * Why static files rather than reading `content/` at request time: the runtime
 * image copies only `public/`, `.next/standalone` and `.next/static` (see
 * docs-site/Dockerfile), so `content/` does not exist in production. Anything
 * needing page source at runtime has to be materialised into one of those three
 * during the build.
 *
 * Why one `_md/` prefix rather than mirroring the routes directly into
 * `public/`: these are build output derived from content/ (itself a symlink to
 * ../docs), so they must not be committed. Emitting them alongside the routes
 * would mean .gitignore had to enumerate every top-level docs section, and the
 * next section someone adds would silently start being committed. One prefix is
 * one ignore rule that cannot rot.
 *
 * Nothing is lost by the prefix: middleware rewrites both the negotiated
 * request (`Accept: text/markdown` on /api/authentication) and the explicit
 * alternate (/api/authentication.md) to the file under `_md/`, so neither URL
 * changes shape for the caller.
 *
 * URL mapping mirrors Nextra's:
 *   content/index.md              -> /                    -> _md/index.md
 *   content/api/index.md          -> /api                 -> _md/api.md
 *   content/api/authentication.md -> /api/authentication   -> _md/api/authentication.md
 *
 * The frontmatter block is kept. It carries the title and description, which is
 * useful to the agents this exists for, and stripping it would make the
 * Markdown representation say less than the HTML one.
 */

import { readdir, mkdir, copyFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = path.join(ROOT, "content");
const PUBLIC_DIR = path.join(ROOT, "public");
/** Single prefix for emitted files - see the note on .gitignore above. */
export const MARKDOWN_PREFIX = "_md";
const OUTPUT_DIR = path.join(PUBLIC_DIR, MARKDOWN_PREFIX);

/** Where emitted files are tracked, so a rebuild can clear the previous set. */
const MANIFEST = path.join(OUTPUT_DIR, "manifest.json");

const MARKDOWN_EXT = /\.mdx?$/;

/**
 * Route and output path for a content file, relative to the content root.
 * Exported for the unit test - the mapping is the part worth pinning.
 */
export function mapContentFile(relativePath) {
  const withoutExt = relativePath.replace(MARKDOWN_EXT, "");
  const segments = withoutExt.split(path.sep);
  const isIndex = segments.at(-1) === "index";
  const routeSegments = isIndex ? segments.slice(0, -1) : segments;
  const route = `/${routeSegments.join("/")}`;
  // The site root has no bare name to hang ".md" off, so it keeps "index.md".
  const output = routeSegments.length === 0 ? "index.md" : `${routeSegments.join(path.sep)}.md`;
  return { route: route === "/" ? "/" : route, output };
}

/**
 * Yields every markdown file under `dir`, following symlinks to both
 * directories (`content` is one) and files. Exported so the symlink handling
 * can be tested against a fixture tree rather than against build output.
 */
export async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // withFileTypes reports the link itself, so follow directories explicitly:
    // `content` is a symlink to `../docs` in every non-Docker build.
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const listed = await readdir(full, { withFileTypes: true }).catch(
        () => null
      );
      if (listed) {
        yield* walk(full);
        continue;
      }
      // readdir failed, so this is a symlink to a file rather than to a
      // directory. `entry.isFile()` reports the link, not its target, so the
      // check below would be false and the page would be dropped silently -
      // rendering as HTML but 404ing on both of its Markdown routes. Resolve
      // the target instead. No symlinked pages exist today; this keeps the
      // first one from disappearing without an error.
      if (MARKDOWN_EXT.test(entry.name)) {
        const target = await stat(full).catch(() => null);
        if (target?.isFile()) {
          yield full;
        }
      }
      continue;
    }
    if (entry.isFile() && MARKDOWN_EXT.test(entry.name)) {
      yield full;
    }
  }
}

async function main() {
  if (!existsSync(CONTENT_DIR)) {
    throw new Error(`content directory not found at ${CONTENT_DIR}`);
  }

  // Clear the previous emission before writing, so a page deleted from the docs
  // does not leave a stale Markdown twin served forever from public/.
  if (existsSync(MANIFEST)) {
    const previous = JSON.parse(
      await (await import("node:fs/promises")).readFile(MANIFEST, "utf8")
    );
    for (const relative of previous.files ?? []) {
      await rm(path.join(OUTPUT_DIR, relative), { force: true });
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const emitted = [];
  for await (const file of walk(CONTENT_DIR)) {
    const relative = path.relative(CONTENT_DIR, file);
    const { output } = mapContentFile(relative);
    const destination = path.join(OUTPUT_DIR, output);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file, destination);
    emitted.push(output);
  }

  emitted.sort();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    MANIFEST,
    `${JSON.stringify({ files: emitted }, null, 2)}\n`,
    "utf8"
  );
  process.stdout.write(
    `emit-markdown: wrote ${emitted.length} files to public/${MARKDOWN_PREFIX}/\n`
  );
}

// Only run when invoked directly, so the mapping above can be imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`emit-markdown failed: ${error.message}\n`);
    process.exit(1);
  });
}
