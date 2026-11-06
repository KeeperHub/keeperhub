import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";
import {
  type AlertsFixture,
  cleanupFailureAlerts,
  seedFailureAlerts,
} from "./utils/failure-alerts";
import { dismissPhoneOverlays } from "./utils/layout";

// A classic scrollbar, as on Windows or Linux: Playwright hides scrollbars
// unless told otherwise, and the app's global scrollbar styles must give way.
test.use({
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  storageState: { cookies: [], origins: [] },
});
const CLASSIC_SCROLLBAR_CSS =
  "*{scrollbar-width:auto!important;scrollbar-color:auto!important}*::-webkit-scrollbar{width:12px!important}";
const FIRST_VISIT = { timeout: 30_000 };
const LOADED = {
  overview: "failure-alerts-health",
  setup: "failure-alerts-methods",
  sent: "failure-alert-history-summary",
} as const;

let fixture: AlertsFixture;

test.beforeAll(async () => {
  fixture = await seedFailureAlerts();
});

test.afterAll(async () => {
  if (fixture) {
    await cleanupFailureAlerts(fixture);
  }
});

async function measure(
  page: Page,
  tab: "overview" | "setup" | "sent"
): Promise<{ scrolls: boolean; box: string }> {
  await page.goto(`/settings/${fixture.orgId}/alerts?tab=${tab}`, {
    waitUntil: "domcontentloaded",
  });
  await page.addStyleTag({ content: CLASSIC_SCROLLBAR_CSS });
  await expect(page.getByTestId(`failure-alerts-tab-${tab}`)).toHaveAttribute(
    "data-state",
    "active",
    FIRST_VISIT
  );
  // Measure once the tab's content is in, so its height is final.
  await expect(page.getByTestId(LOADED[tab])).toBeVisible(FIRST_VISIT);
  const main = page.getByTestId("settings-main");
  const scrolls = await main.evaluate(
    (el) => el.scrollHeight > el.clientHeight
  );
  const rect = await page.getByTestId("failure-alerts-settings").boundingBox();
  return { scrolls, box: `${rect?.x}:${rect?.width}` };
}

// From md up the settings column reserves the scrollbar gutter; phones use overlay scrollbars.
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 1024, height: 900 },
]) {
  test(`the Alerts tabs sit at the same width at ${viewport.width}px, whether or not the page scrolls`, async ({
    page,
  }) => {
    await dismissPhoneOverlays(page);
    await page.setViewportSize(viewport);
    await signIn(page, fixture.email, fixture.password);
    const results = [
      await measure(page, "overview"),
      await measure(page, "setup"),
      await measure(page, "sent"),
    ];
    const summary = results.map((r) => `${r.box}${r.scrolls ? "*" : ""}`);
    // On a desktop width the check only means something when one tab scrolls and another does not.
    if (viewport.width >= 1024) {
      expect(
        results.some((r) => r.scrolls),
        summary.join(" ")
      ).toBe(true);
      expect(
        results.some((r) => !r.scrolls),
        summary.join(" ")
      ).toBe(true);
    }
    expect(new Set(results.map((r) => r.box)).size, summary.join(" ")).toBe(1);
  });
}
