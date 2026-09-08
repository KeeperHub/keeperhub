import Link from "next/link";

/**
 * Segment-level 404 for `/hub/tags/[tag]`.
 *
 * Without this file, calling `notFound()` from the dynamic on-demand path
 * (reserved or unknown slug) hits Next's global `_not-found` handler, which
 * — in production builds where the route is SSG with `revalidate` and
 * `dynamicParams = true` — has been observed to surface as a 500 instead
 * of a 404 in CI. Providing an explicit segment-level `not-found.tsx`
 * short-circuits that path and guarantees a 404 response with this UI.
 */
export default function TagNotFound(): React.ReactElement {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24 text-center">
      <h1 className="font-semibold text-2xl text-foreground">Tag not found</h1>
      <p className="mt-3 text-muted-foreground text-sm">
        We couldn&apos;t find any workflows under that tag.
      </p>
      <Link
        className="mt-6 inline-block text-[var(--color-text-accent)] text-sm underline-offset-2 hover:underline"
        href="/hub?tab=workflows"
      >
        Browse all workflow templates
      </Link>
    </main>
  );
}
