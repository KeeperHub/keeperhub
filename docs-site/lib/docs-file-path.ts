// Nextra sets a page's `metadata.filePath` from the bundler's resource path,
// which is the file's *resolved* location relative to the Next project dir
// (docs-site). That value therefore depends on how `content` is materialised,
// and the two layouts we build disagree:
//
//   symlink layout (any non-Docker build, `content` -> `../docs`)
//     the bundler resolves the link, so filePath is `../docs/<page>.md`
//   copied layout (the Docker image does `rm -f ./content` + `COPY docs/ ./content/`)
//     `content` is a real directory, so filePath is `content/<page>.md`
//
// The docs theme builds "Edit this page" as `docsRepositoryBase + filePath`,
// and that base already ends in `/docs`. So both shapes have to be reduced to
// the page's path relative to the docs content root, or the link 404s.
//
// `src/content` is covered too because that is Nextra's other content-root
// convention; if docs-site ever moves to the `src/` layout this keeps working.

const LEADING_PARENT_SEGMENTS = /^(?:\.\.\/)+/;
const CONTENT_ROOT = /^(?:src\/)?(?:content|docs)\//;

/**
 * Reduce a Nextra `filePath` to the page path relative to the docs content
 * root, so it can be appended to `docsRepositoryBase`.
 *
 * A path matching no known content root is returned unchanged.
 */
export function toDocsRelativePath(filePath: string): string {
  return filePath.replace(LEADING_PARENT_SEGMENTS, "").replace(CONTENT_ROOT, "");
}
