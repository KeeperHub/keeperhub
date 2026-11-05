import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";
import {
  type AlertsFixture,
  cleanupFailureAlerts,
  countMethods,
  readOrgPause,
  readOrgThreshold,
  readOverride,
  seedFailureAlerts,
} from "./utils/failure-alerts";
import { dismissPhoneOverlays } from "./utils/layout";

// A user of its own, signed in per test, so the shared test account is untouched.
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

const DESKTOP = { width: 1280, height: 1100 };
const WIDTHS = [390, 768, 1280] as const;
const MD = 768;
// A section's code is compiled on first visit in development.
const FIRST_VISIT = { timeout: 30_000 };
const SAVE_TIMEOUT = { timeout: 30_000 };

let fixture: AlertsFixture;

test.beforeAll(async () => {
  fixture = await seedFailureAlerts();
});

test.afterAll(async () => {
  if (fixture) {
    await cleanupFailureAlerts(fixture);
  }
});

test.beforeEach(async ({ page }) => {
  await dismissPhoneOverlays(page);
  await page.setViewportSize(DESKTOP);
  await signIn(page, fixture.email, fixture.password);
});

function methodCards(page: Page): Locator {
  return page
    .getByTestId("failure-alerts-methods")
    .getByTestId("failure-alert-method");
}

function methodCard(page: Page, kind: string): Locator {
  return methodCards(page).and(page.locator(`[data-kind="${kind}"]`));
}

type AlertsTab = "overview" | "setup" | "sent";

async function openAlerts(page: Page, tab: AlertsTab = "setup"): Promise<void> {
  await page.goto(`/settings/${fixture.orgId}/alerts?tab=${tab}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("failure-alerts-settings")).toBeVisible(
    FIRST_VISIT
  );
  await expect(page.getByTestId(`failure-alerts-tab-${tab}`)).toHaveAttribute(
    "data-state",
    "active"
  );
  if (tab === "setup") {
    await expect(methodCard(page, "email")).toBeVisible(FIRST_VISIT);
  }
}

// The Properties panel sits beside the canvas from md up, in the Configuration sheet below it.
async function openProperties(
  page: Page,
  workflowId: string
): Promise<Locator> {
  await page.goto(`/workflows/${workflowId}`, {
    waitUntil: "domcontentloaded",
  });
  const width = page.viewportSize()?.width ?? DESKTOP.width;
  if (width < MD) {
    await page.getByTitle("Configuration", { exact: true }).click(FIRST_VISIT);
    const inSheet = page
      .getByRole("dialog")
      .getByTestId("workflow-failure-alerts");
    await expect(inSheet).toBeVisible(FIRST_VISIT);
    return inSheet;
  }
  const section = page.getByTestId("workflow-failure-alerts").first();
  await expect(section).toBeVisible(FIRST_VISIT);
  return section;
}

async function pageOverflow(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  );
}

// Elements sticking out past either side of the viewport, or scrolling inside.
async function pastTheEdge(page: Page, items: Locator): Promise<number> {
  const width = page.viewportSize()?.width ?? 0;
  const boxes = await items.evaluateAll((elements) =>
    elements.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        inner: el.scrollWidth - el.clientWidth,
      };
    })
  );
  return boxes.filter((b) => b.left < 0 || b.right > width + 0.5 || b.inner > 0)
    .length;
}

test.describe("Failure alerts", () => {
  test("Overview opens first, with Status and Needs attention", async ({
    page,
  }) => {
    await page.goto(`/settings/${fixture.orgId}/alerts`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByTestId("failure-alerts-tab-overview")
    ).toHaveAttribute("data-state", "active", FIRST_VISIT);
    await expect(page.getByTestId("failure-alerts-switch")).toBeVisible();
    await expect(page.getByTestId("failure-alerts-methods")).toHaveCount(0);
    await page.getByTestId("failure-alerts-tab-sent").click();
    await expect(page).toHaveURL(/[?&]tab=sent/);
    await expect(page.getByTestId("failure-alert-history")).toBeVisible();
  });

  test("Setup shows who gets alerts, then the rules", async ({ page }) => {
    await openAlerts(page);
    const rules = page.getByTestId("failure-alerts-rules");
    await expect(rules).toBeVisible();
    expect(
      await page.evaluate(() => {
        const methods = document.querySelector(
          '[data-testid="failure-alerts-methods"]'
        );
        const after = document.querySelector(
          '[data-testid="failure-alerts-rules"]'
        );
        return Boolean(
          methods &&
            after &&
            methods.compareDocumentPosition(after) &
              Node.DOCUMENT_POSITION_FOLLOWING
        );
      }),
      "methods come before the rules"
    ).toBe(true);
    await expect(page.locator("#failure-threshold")).toHaveValue("5");

    await expect(methodCards(page)).toHaveCount(2);
    await expect(methodCards(page).first()).toHaveAttribute(
      "data-kind",
      "email"
    );
    await expect(methodCard(page, "email")).toHaveAttribute(
      "data-status",
      "working"
    );
    // The seeded Telegram method was paused by a failed delivery.
    await expect(methodCard(page, "telegram")).toHaveAttribute(
      "data-status",
      "paused"
    );
    for (const card of await methodCards(page).all()) {
      await expect(
        card.getByTestId("failure-alert-method-status")
      ).toBeVisible();
    }
  });

  test("a method that cannot receive alerts is refused and not saved", async ({
    page,
  }) => {
    await openAlerts(page);
    await page.getByTestId("failure-alerts-add-method").click();
    const fresh = methodCards(page).last();
    const picker = fresh.getByTestId("failure-alert-method-picker");
    await expect(picker).toBeVisible();
    // The only Discord connection holds no credentials, so the server's check fails without a network call.
    await picker.locator('input[value="discord"]').check({ force: true });
    // Each method is checked when saved; a refusal shows on its card.
    await fresh.getByTestId("failure-alert-method-save-button").click();
    const refusal = fresh.getByTestId("failure-alert-save-error");
    await expect(refusal).toBeVisible(SAVE_TIMEOUT);
    await expect(refusal).toContainText("cannot receive notifications");
    await expect(fresh).toHaveAttribute("data-dirty", "true");
    expect(await countMethods(fixture.orgId, "discord")).toBe(0);

    await openAlerts(page);
    await expect(methodCards(page)).toHaveCount(2);
  });

  test("the rules save themselves, with Undo", async ({ page }) => {
    await openAlerts(page);
    const threshold = page.locator("#failure-threshold");
    await threshold.fill("4");
    const status = page.getByTestId("failure-alerts-rules-autosave");
    await expect(status).toHaveText("Saved", SAVE_TIMEOUT);
    await expect
      .poll(() => readOrgThreshold(fixture.orgId), SAVE_TIMEOUT)
      .toBe(4);
    await page
      .locator("[data-sonner-toast]")
      .getByRole("button", { name: "Undo" })
      .click();
    await expect
      .poll(() => readOrgThreshold(fixture.orgId), SAVE_TIMEOUT)
      .toBe(5);
    await expect(threshold).toHaveValue("5");
  });

  test("the Status switch pauses through the form and resumes at once", async ({
    page,
  }) => {
    await openAlerts(page, "overview");
    // Turning the switch off opens the pause form; it stays on until confirmed.
    const toggle = page.getByTestId("failure-alerts-switch");
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await toggle.click();
    const form = page.getByTestId("failure-alerts-pause-form");
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await expect(form).toBeVisible();
    await form.getByLabel("Reason (optional)").fill("E2E maintenance");
    await form.getByTestId("failure-alerts-pause-submit").click();

    const paused = page.getByTestId("failure-alerts-paused");
    await expect(paused).toBeVisible(SAVE_TIMEOUT);
    await expect(paused).toContainText("E2E maintenance");
    await expect
      .poll(() => readOrgPause(fixture.orgId), SAVE_TIMEOUT)
      .not.toBeNull();

    const banner = page.getByTestId("failure-alerts-paused-banner");
    await expect(banner).toBeVisible(SAVE_TIMEOUT);

    await openAlerts(page, "overview");
    await expect(paused).toBeVisible();
    await expect(banner).toBeVisible(SAVE_TIMEOUT);
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    // Turning it back on resumes at once.
    await toggle.click();
    await expect(paused).toHaveCount(0, SAVE_TIMEOUT);
    await expect(banner).toHaveCount(0, SAVE_TIMEOUT);
    await expect
      .poll(() => readOrgPause(fixture.orgId), SAVE_TIMEOUT)
      .toBeNull();
    await openAlerts(page, "overview");
    await expect(paused).toHaveCount(0);
  });

  test("history lists the alerts that went out", async ({ page }) => {
    await openAlerts(page, "sent");
    const rows = page.getByTestId("failure-alert-history-row");
    await expect(rows.first()).toBeVisible(FIRST_VISIT);
    const alerts = rows.and(page.locator('[data-kind="alert"]'));
    await expect(alerts.filter({ hasText: fixture.failingName })).toHaveCount(
      1
    );
    await expect(alerts.filter({ hasText: fixture.alertedName })).toHaveCount(
      1
    );
  });

  test("workflow Properties: mute, unmute, custom rules tab with pause, back to org rules", async ({
    page,
  }) => {
    const section = await openProperties(page, fixture.failingId);

    const muteOpen = section.getByTestId("failure-alerts-mute-open");
    await expect(section).toHaveAttribute("data-source", "org");
    await muteOpen.click();
    const mute = section.getByTestId("failure-alerts-mute");
    await expect(mute).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(mute).toHaveCount(0);
    await muteOpen.click();
    await mute.locator('[data-mute="24h"]').click();
    await expect
      .poll(
        async () => (await readOverride(fixture.failingId))?.mutedUntil,
        SAVE_TIMEOUT
      )
      .toBeTruthy();
    await expect(section).toHaveAttribute("data-muted", "true");
    await section.getByTestId("failure-alerts-unmute").click();
    await expect
      .poll(
        async () => (await readOverride(fixture.failingId))?.mutedUntil ?? null,
        SAVE_TIMEOUT
      )
      .toBeNull();

    await expect(section).toHaveAttribute("data-muted", "false");
    // Both tabs show Rules, Email and Methods; a tab only shows, its button switches.
    await expect(section.getByTestId("failure-alerts-tab-org")).toHaveAttribute(
      "data-state",
      "active"
    );
    await expect(section.getByTestId("failure-alerts-in-use")).toBeVisible();
    await section.getByTestId("failure-alerts-tab-custom").click();
    await expect(section).toHaveAttribute("data-source", "org");
    await section.getByTestId("failure-alerts-use-custom").click();
    await expect(section).toHaveAttribute(
      "data-source",
      "custom",
      SAVE_TIMEOUT
    );
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 5 });
    const custom = section.getByTestId("failure-alerts-custom");
    await expect(custom).toBeVisible();
    // No Save or Cancel of its own: edits save themselves.
    await expect(custom.getByRole("button", { name: "Save" })).toHaveCount(0);
    const threshold = custom.locator("#wf-failure-threshold");
    await expect(threshold).toHaveValue("5");
    const pauseBox = custom.locator("#wf-pause-workflow");
    await pauseBox.click();
    await threshold.fill("2");
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 2, pauseWorkflow: true });
    await expect(section.getByTestId("failure-alerts-autosave")).toHaveText(
      "All changes saved.",
      SAVE_TIMEOUT
    );
    await expect(
      section.getByTestId("failure-alerts-tab-custom")
    ).toHaveAttribute("data-state", "active");

    // Back to the org rules is an explicit choice: it drops the custom rules.
    await section.getByTestId("failure-alerts-tab-org").click();
    await expect(custom).toHaveCount(0);
    await section.getByTestId("failure-alerts-reset").click();
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toBeNull();
    await expect(section).toHaveAttribute("data-source", "org");
  });

  test("analytics marks the run that set off an alert", async ({ page }) => {
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    const table = page.getByTestId("runs-table");
    await expect(table).toHaveAttribute("data-ready", "true", FIRST_VISIT);
    // Analytics lists runs only: no alert rows, no Alerts source.
    await page.getByRole("button", { name: /^Source/ }).click();
    await expect(page.getByRole("button", { name: /Alerts/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Only the newest failed run before the alert carries it.
    const chips = table.getByTestId("run-alert-sent");
    await expect(chips).toHaveCount(1, SAVE_TIMEOUT);
    await expect(chips).toContainText("Alert sent");
    await expect(chips).toContainText("Email");
    await chips.click();
    await expect(page).toHaveURL(
      new RegExp(`/alerts\\?tab=sent&workflow=${fixture.failingId}`),
      FIRST_VISIT
    );
    await expect(
      page.getByTestId("failure-alert-history-workflow-chip")
    ).toBeVisible(FIRST_VISIT);
  });

  for (const width of WIDTHS) {
    test(`no sideways scroll at ${width}px on Alerts and Properties`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1200 });
      await openAlerts(page);
      expect(await pageOverflow(page), "Setup overflow").toBeLessThanOrEqual(0);
      expect(
        await pastTheEdge(page, methodCards(page)),
        "method cards past the edge"
      ).toBe(0);
      for (const tab of ["overview", "sent"] as const) {
        await openAlerts(page, tab);
        expect(await pageOverflow(page), `${tab} overflow`).toBeLessThanOrEqual(
          0
        );
      }

      const section = await openProperties(page, fixture.failingId);
      await section.scrollIntoViewIfNeeded();
      expect(
        await pageOverflow(page),
        "workflow page overflow"
      ).toBeLessThanOrEqual(0);
      expect(await pastTheEdge(page, section), "Properties section").toBe(0);
    });
  }
});
