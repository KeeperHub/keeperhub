// Deliberately empty.
//
// docs-site's `content` symlink points at `../docs`, which sits outside
// docs-site. Turbopack refuses a symlink that escapes the project root, so the
// root has to be inferred as the repository root for the docs build to resolve
// its own content at all. That inference has a side effect: Next then finds the
// main application's `instrumentation.ts` at the repository root and pulls it
// into the docs bundle, where its `@/lib/...` imports do not resolve and the
// build dies with module-not-found.
//
// A file here shadows that one. It must stay empty - the main app's
// instrumentation wires up Sentry and workflow error context for the
// application runtime, none of which belongs in a static documentation site.
//
// Removing this file breaks `next build` for docs-site outside the Docker
// image, which is the only place the "Edit this page" links can be verified.
export function register(): void {
  // no-op
}
