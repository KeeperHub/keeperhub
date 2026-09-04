/**
 * Server-rendered footer for the signed-out landing page.
 *
 * `/` sends a visitor without a session to `/welcome`, so `/welcome` is the
 * first - and for a crawler that does not execute JavaScript, the only - page
 * this origin serves. Before this existed the raw HTML held under 200 characters
 * of text (a logo, "Sign in to KeeperHub", and the provider buttons), which told
 * an AI crawler nothing about what the product is and left no path to the API,
 * the docs, or the machine-readable surfaces.
 *
 * It renders below the fold: the auth card above keeps its own `min-h-screen`
 * box, so the first viewport is unchanged and this is reached by scrolling.
 *
 * Content comes from lib/site/content.ts, the same source the `/` markdown
 * representation renders from, so the two cannot drift.
 */

import Link from "next/link";
import { publicPage, type SiteLink } from "@/lib/site/content";

function isInternal(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function FooterLink({ link }: { link: SiteLink }): React.ReactElement {
  const className =
    "text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline";
  if (isInternal(link.href)) {
    return (
      <Link className={className} href={link.href}>
        {link.label}
      </Link>
    );
  }
  return (
    <a className={className} href={link.href} rel="noopener">
      {link.label}
    </a>
  );
}

export function SiteFooter(): React.ReactElement | null {
  const home = publicPage("/");
  if (!home) {
    return null;
  }
  const [summary, ...linkSections] = home.sections;

  return (
    <footer className="border-border border-t bg-background">
      <div className="mx-auto w-full max-w-4xl px-6 py-12">
        <h2 className="font-semibold text-lg tracking-tight">{home.heading}</h2>
        <div className="mt-3 space-y-3">
          {summary.paragraphs?.map((paragraph) => (
            <p
              className="text-muted-foreground text-sm leading-relaxed"
              key={paragraph}
            >
              {paragraph}
            </p>
          ))}
        </div>

        <div className="mt-8 grid gap-8 sm:grid-cols-2">
          {linkSections.map((section) => (
            <section key={section.heading}>
              <h3 className="font-medium text-sm">{section.heading}</h3>
              {section.paragraphs?.map((paragraph) => (
                <p
                  className="mt-2 text-muted-foreground text-sm leading-relaxed"
                  key={paragraph}
                >
                  {paragraph}
                </p>
              ))}
              <ul className="mt-3 space-y-1.5 text-sm">
                {section.links?.map((link) => (
                  <li key={`${link.label}-${link.href}`}>
                    <FooterLink link={link} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </footer>
  );
}
