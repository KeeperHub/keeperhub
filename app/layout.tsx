import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Provider } from "jotai";
import { cookies } from "next/headers";
import Script from "next/script";
import type { ReactNode } from "react";
import { AppBanner } from "@/components/app-banner";
import { AuthProvider } from "@/components/auth/provider";
import { KeeperHubExtensionLoader } from "@/components/extension-loader";
import { FeatureSessionInvalidator } from "@/components/feature-session-invalidator";
import { GlobalModals } from "@/components/global-modals";
import { PendingTemplateRunner } from "@/components/hub/pending-template-runner";
import { LayoutContent } from "@/components/layout-content";
import { MobileWarningDialog } from "@/components/mobile-warning-dialog";
import { EditorWalkthrough } from "@/components/onboarding/editor-walkthrough";
import { OrgDataSync } from "@/components/org-data-sync";
import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { PendingScanRunner } from "@/components/scan/pending-scan-runner";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { WalletProvisioningTrigger } from "@/components/wallet/wallet-provisioning-trigger";
import { mono, sans } from "@/lib/fonts";
import { siteJsonLdScript } from "@/lib/site/structured-data";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com"
  ),
  title: "KeeperHub - Blockchain Workflow Automation",
  description:
    "Build powerful blockchain workflow automations with a visual, node-based editor. Built with Next.js and React Flow.",
  // Resolved against metadataBase, so a self-hosted deployment canonicalises to
  // its own origin rather than to app.keeperhub.com. Agents use rel=canonical
  // for entity resolution and attribution; pointing it at somebody else's
  // origin is worse than omitting it. Routes needing a different canonical
  // declare their own `alternates` - see app/hub/page.tsx.
  alternates: { canonical: "/" },
  openGraph: {
    title: "KeeperHub - Blockchain Workflow Automation",
    description:
      "Build powerful blockchain workflow automations with a visual, node-based editor.",
    type: "website",
    siteName: "KeeperHub",
    images: [
      {
        url: "/api/og/default",
        width: 1200,
        height: 630,
        alt: "KeeperHub - Blockchain Workflow Automation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "KeeperHub - Blockchain Workflow Automation",
    description:
      "Build powerful blockchain workflow automations with a visual, node-based editor.",
    images: ["/api/og/default"],
  },
  // Discourage automatic translation of the app shell. External
  // translators (Chrome's built-in translator, browser extensions) swap
  // text nodes in-place, which leaves React's fiber tree referencing
  // the original parents and throws `NotFoundError` on the next
  // insertBefore/removeChild. See facebook/react#11538.
  other: {
    google: "notranslate",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

// Workaround for a Next.js 16 dev-mode race: on browser back-or-forward
// navigation (including Cmd+Shift+T tab restore) the framework
// occasionally streams an RSC payload the React client never finishes
// hydrating, leaving client-component-heavy pages (/hub, /billing, etc.)
// stuck on the loading skeleton with zero interactive elements.
// Detection uses the Performance Navigation Timing API to check the
// navigation type; a forced reload converts the back-or-forward entry
// into a normal navigation and React hydrates cleanly. Production is
// unaffected — the JSX gate below uses process.env.NODE_ENV which
// Webpack/Turbopack inline-substitute at build time, so the entire
// <Script> element is dead-code-eliminated from prod bundles.
const ROOT_DEV_BFCACHE_RELOAD =
  "if(typeof window!=='undefined'&&typeof performance!=='undefined'){var n=performance.getEntriesByType('navigation')[0];if(n&&n.type==='back_forward'){window.location.reload();}}";

// Absent unless a deployment names a status page to embed. KeeperHub's own
// environments set it in their Helm values; every other deployment gets no
// third-party script and no outbound request.
const STATUS_EMBED_SRC = process.env.STATUS_EMBED_SRC;

// Width values MUST match COLLAPSED_WIDTH (60) and EXPANDED_WIDTH (200)
// in components/navigation-sidebar.tsx. DEFAULT_STATE.sidebar=true in
// lib/hooks/use-persisted-nav-state.ts means new users default to
// expanded, so 200 is the right pre-cookie guess.
const NAV_SIDEBAR_COOKIE = "kh_nav_sidebar_w";
const NAV_SIDEBAR_WIDTH_DEFAULT = "200px";

async function readNavSidebarWidth(): Promise<string> {
  const store = await cookies();
  const raw = store.get(NAV_SIDEBAR_COOKIE)?.value;
  if (raw === "60" || raw === "200") {
    return `${raw}px`;
  }
  return NAV_SIDEBAR_WIDTH_DEFAULT;
}

type RootLayoutProps = {
  children: ReactNode;
};

const RootLayout = async ({ children }: RootLayoutProps) => {
  // Read sidebar width on the server so wrappers using
  // `md:ml-[var(--nav-sidebar-width,60px)]` paint at the correct margin
  // on first render — no JS hop, no layout shift when the sidebar
  // hydrates. Cookie is written client-side by usePersistedNavState.
  const navSidebarWidth = await readNavSidebarWidth();
  return (
    <html
      lang="en"
      style={{ "--nav-sidebar-width": navSidebarWidth } as React.CSSProperties}
      suppressHydrationWarning
      translate="no"
    >
      <body className={cn(sans.variable, mono.variable, "antialiased")}>
        {/*
          schema.org identity for the whole origin: the Organization that
          operates the service, this WebSite, and the SoftwareApplication with
          its plans as Offers. Emitted server-side on every route so an agent
          that renders no JavaScript still resolves who publishes this app and
          what it costs. Built from lib/billing/plans.ts, so prices here cannot
          drift from the ones we bill.
        */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD has to be inlined as raw text; the payload is deployment config serialised with JSON.stringify, with `<` escaped in siteJsonLdScript.
          dangerouslySetInnerHTML={{ __html: siteJsonLdScript() }}
          type="application/ld+json"
        />
        <KeeperHubExtensionLoader />
        <ThemeProvider
          attribute="class"
          disableTransitionOnChange
          forcedTheme="dark"
        >
          <Provider>
            <AuthProvider>
              <OrgDataSync />
              <FeatureSessionInvalidator />
              <PendingTemplateRunner />
              <PendingScanRunner />
              <WalletProvisioningTrigger />
              <OverlayProvider>
                <AppBanner />
                <LayoutContent>{children}</LayoutContent>
                <Toaster />
                <GlobalModals />
                <MobileWarningDialog />
                <EditorWalkthrough />
              </OverlayProvider>
            </AuthProvider>
          </Provider>
        </ThemeProvider>
        {process.env.NODE_ENV === "development" && (
          <Script id="root-dev-bfcache-reload" strategy="beforeInteractive">
            {ROOT_DEV_BFCACHE_RELOAD}
          </Script>
        )}
        {/*
          The status widget, loaded only where one is configured.

          It used to be unconditional, which meant every page load of every
          deployment fetched a script from a host KeeperHub operates - including
          deployments run by someone else, whose users then beaconed us on every
          visit. Read at runtime rather than through a NEXT_PUBLIC_ variable so a
          deployment running a prebuilt image can change it without rebuilding.
        */}
        {STATUS_EMBED_SRC && (
          <Script src={STATUS_EMBED_SRC} strategy="lazyOnload" />
        )}
      </body>
    </html>
  );
};

export default RootLayout;
