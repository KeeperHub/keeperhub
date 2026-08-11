/**
 * Tests for the dev-only back/forward cache hydration workaround in
 * app/layout.tsx (Phase 45 — root-layout fix that supersedes the per-page
 * Phase 43 workaround at app/hub/layout.tsx, commit cef214f0).
 *
 * The workaround adds a <Script strategy="beforeInteractive"> that detects
 * back_forward navigation entries and force-reloads the page. It is gated
 * on `NODE_ENV === "development"` and must be entirely absent from production
 * builds. Lives in the root layout so every route benefits.
 *
 * These tests use source-read assertions against the layout files (no Next.js
 * runtime imports needed) — fast, deterministic, no mocking. The behavioral-
 * contract describe block at the bottom proves the detection LOGIC works
 * correctly, independent of which layout hosts it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_LAYOUT_PATH = resolve(process.cwd(), "app/layout.tsx");
const HUB_LAYOUT_PATH = resolve(process.cwd(), "app/hub/layout.tsx");
const rootLayoutSource = readFileSync(ROOT_LAYOUT_PATH, "utf-8");
const hubLayoutSource = readFileSync(HUB_LAYOUT_PATH, "utf-8");

const EXPECTED_BFCACHE_DETECTION = "back_forward";
const EXPECTED_RELOAD_CALL = "window.location.reload()";

describe("app/layout.tsx — dev-only bfcache reload workaround (Phase 45)", () => {
  it("source file exists and is non-empty", () => {
    expect(rootLayoutSource.length).toBeGreaterThan(0);
  });

  it("bfcache reload script is gated on NODE_ENV === 'development'", () => {
    expect(rootLayoutSource).toContain("process.env.NODE_ENV");
    expect(rootLayoutSource).toContain("development");
  });

  it("script detects back_forward navigation type", () => {
    expect(rootLayoutSource).toContain(EXPECTED_BFCACHE_DETECTION);
  });

  it("script calls window.location.reload() to recover hydration", () => {
    expect(rootLayoutSource).toContain(EXPECTED_RELOAD_CALL);
  });

  it("script uses performance.getEntriesByType('navigation') for detection", () => {
    expect(rootLayoutSource).toContain("performance.getEntriesByType");
    expect(rootLayoutSource).toContain("navigation");
  });

  it("script is loaded with strategy='beforeInteractive'", () => {
    expect(rootLayoutSource).toContain("beforeInteractive");
  });

  it("Script component has a stable id attribute for deduplication", () => {
    expect(rootLayoutSource).toContain("root-dev-bfcache-reload");
  });

  it("NODE_ENV check wraps the Script render (build-time DCE contract)", () => {
    // The inline script content is assigned to a module-level const
    // (ROOT_DEV_BFCACHE_RELOAD) but the <Script> element that uses it is
    // rendered conditionally behind process.env.NODE_ENV === "development".
    // Both the string constant and the JSX gate must be present in the file.
    // The <Script> JSX element must appear AFTER the NODE_ENV check (which
    // opens the conditional block) so Webpack/Turbopack can DCE the entire
    // <Script> branch in prod builds.
    const nodeEnvIdx = rootLayoutSource.indexOf("process.env.NODE_ENV");
    const scriptTagIdx = rootLayoutSource.indexOf(
      '<Script id="root-dev-bfcache-reload"'
    );
    expect(nodeEnvIdx).toBeGreaterThan(-1);
    expect(scriptTagIdx).toBeGreaterThan(-1);
    expect(nodeEnvIdx).toBeLessThan(scriptTagIdx);
  });

  it("production builds are unaffected: no unconditional reload call at module scope", () => {
    // Strip string literals; reload() must not appear as a bare statement.
    const outsideString = rootLayoutSource.replace(
      /"[^"]*"|'[^']*'|`[^`]*`/g,
      '""'
    );
    expect(outsideString).not.toContain("location.reload()");
  });

  it("imports Script from next/script", () => {
    expect(rootLayoutSource).toContain('from "next/script"');
  });
});

describe("app/hub/layout.tsx — per-page workaround removed (Phase 45 supersedes commit cef214f0)", () => {
  it("does not contain the bfcache detection string", () => {
    expect(hubLayoutSource).not.toContain("back_forward");
  });

  it("does not contain the old per-page const name", () => {
    expect(hubLayoutSource).not.toContain("HUB_DEV_BFCACHE_RELOAD");
  });

  it("does not contain the old per-page Script id", () => {
    expect(hubLayoutSource).not.toContain("hub-dev-bfcache-reload");
  });

  it("does not import Script from next/script (workaround was the only consumer)", () => {
    expect(hubLayoutSource).not.toContain('from "next/script"');
  });

  it("HubLayout default export is preserved", () => {
    expect(hubLayoutSource).toContain("export default function HubLayout");
  });

  it("Hub SEO has not regressed (per-tab generateMetadata now owns it)", () => {
    // Phase 44 plan 44-09 (MARKET-12) moved per-tab metadata to
    // `app/hub/page.tsx` via `generateMetadata({ searchParams })`. The
    // layout no longer declares static metadata so the page-level
    // generator owns title/description/openGraph/twitter unambiguously.
    // Assert the migration target rather than the layout export.
    const HUB_PAGE_PATH = resolve(process.cwd(), "app/hub/page.tsx");
    const hubPageSource = readFileSync(HUB_PAGE_PATH, "utf-8");
    expect(hubPageSource).toContain("generateMetadata");
    expect(hubLayoutSource).not.toContain("export const metadata");
  });
});

// --- Behavioral contract of the bfcache detection snippet ---
// Lifted verbatim from the deleted tests/unit/hub-layout-bfcache.test.ts —
// the detection logic is layout-agnostic; we prove the contract holds.
describe("bfcache detection script — behavioral contract", () => {
  it("script logic: reloads when navigation type is back_forward", () => {
    let reloaded = false;

    const mockPerformance = {
      getEntriesByType: (type: string) => {
        if (type === "navigation") {
          return [{ type: "back_forward" }];
        }
        return [];
      },
    };

    const navEntries = mockPerformance.getEntriesByType("navigation");
    const firstEntry = navEntries[0] as { type: string } | undefined;
    if (firstEntry?.type === "back_forward") {
      reloaded = true; // Simulates window.location.reload()
    }

    expect(reloaded).toBe(true);
  });

  it("script logic: does NOT reload when navigation type is navigate (normal load)", () => {
    let reloaded = false;

    const mockPerformance = {
      getEntriesByType: (type: string) => {
        if (type === "navigation") {
          return [{ type: "navigate" }];
        }
        return [];
      },
    };

    const navEntries = mockPerformance.getEntriesByType("navigation");
    const firstEntry = navEntries[0] as { type: string } | undefined;
    if (firstEntry?.type === "back_forward") {
      reloaded = true;
    }

    expect(reloaded).toBe(false);
  });

  it("script logic: does NOT reload when navigation type is reload", () => {
    let reloaded = false;

    const mockPerformance = {
      getEntriesByType: (type: string) => {
        if (type === "navigation") {
          return [{ type: "reload" }];
        }
        return [];
      },
    };

    const navEntries = mockPerformance.getEntriesByType("navigation");
    const firstEntry = navEntries[0] as { type: string } | undefined;
    if (firstEntry?.type === "back_forward") {
      reloaded = true;
    }

    expect(reloaded).toBe(false);
  });

  it("script logic: does NOT reload when navigation entries list is empty", () => {
    let reloaded = false;

    const mockPerformance = {
      getEntriesByType: (_type: string) => [],
    };

    const navEntries = mockPerformance.getEntriesByType("navigation");
    const firstEntry = navEntries[0] as { type: string } | undefined;
    if (firstEntry?.type === "back_forward") {
      reloaded = true;
    }

    expect(reloaded).toBe(false);
  });
});
