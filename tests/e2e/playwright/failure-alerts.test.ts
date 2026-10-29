import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";
import {
  type AlertsFixture,
  cleanupFailureAlerts,
  countMethods,
  readOrgPause,
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
// Wording is still settling; replace with testids once the panel has them.
const CUSTOMIZE_LABEL = /^(Customize|Change for this workflow)$/;
const RESET_LABEL = /^(Use org setting|Reset to org rules)$/;

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

async function openAlerts(page: Page): Promise<void> {
  await page.goto(`/settings/${fixture.orgId}/alerts`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("failure-alerts-settings")).toBeVisible(
    FIRST_VISIT
  );
  await expect(methodCard(page, "email")).toBeVisible(FIRST_VISIT);
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
  test("Alerts page shows the rules, then a card per method", async ({
    page,
  }) => {
    await openAlerts(page);
    const rules = page.getByTestId("failure-alerts-rules");
    await expect(rules).toBeVisible();
    expect(
      await page.evaluate(() => {
        const a = document.querySelector(
          '[data-testid="failure-alerts-rules"]'
        );
        const b = document.querySelector(
          '[data-testid="failure-alerts-methods"]'
        );
        return Boolean(
          a &&
            b &&
            a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
        );
      }),
      "rules come before the methods"
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
    await page
      .getByTestId("failure-alerts-methods")
      .getByRole("button", { name: "Add a method" })
      .click();
    const fresh = methodCards(page).last();
    const picker = fresh.getByTestId("failure-alert-method-picker");
    await expect(picker).toBeVisible();
    // The only Discord connection holds no credentials, so the server's check fails without a network call.
    await picker.locator('input[value="discord"]').check({ force: true });
    await fresh.getByRole("button", { name: /^Save / }).click();
    const refusal = fresh.getByTestId("failure-alert-save-error");
    await expect(refusal).toBeVisible(SAVE_TIMEOUT);
    await expect(refusal).toContainText("cannot receive notifications");
    await expect(fresh).toHaveAttribute("data-dirty", "true");
    expect(await countMethods(fixture.orgId, "discord")).toBe(0);

    await openAlerts(page);
    await expect(methodCards(page)).toHaveCount(2);
  });

  test("pausing alerts shows the notice until Resume now", async ({ page }) => {
    await openAlerts(page);
    await page.getByRole("button", { name: "Pause alerts" }).click();
    const form = page.getByTestId("failure-alerts-pause-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Reason (optional)").fill("E2E maintenance");
    await form.getByRole("button", { name: "Pause", exact: true }).click();

    const paused = page.getByTestId("failure-alerts-paused");
    await expect(paused).toBeVisible(SAVE_TIMEOUT);
    await expect(paused).toContainText("E2E maintenance");
    await expect
      .poll(() => readOrgPause(fixture.orgId), SAVE_TIMEOUT)
      .not.toBeNull();

    await openAlerts(page);
    await expect(paused).toBeVisible();
    await paused.getByRole("button", { name: "Resume now" }).click();
    await expect(paused).toHaveCount(0, SAVE_TIMEOUT);
    await expect
      .poll(() => readOrgPause(fixture.orgId), SAVE_TIMEOUT)
      .toBeNull();
    await openAlerts(page);
    await expect(paused).toHaveCount(0);
  });

  test("history lists the alerts that went out", async ({ page }) => {
    await openAlerts(page);
    const history = page.getByTestId("failure-alert-history");
    await expect(history.locator("li").first()).toBeVisible(FIRST_VISIT);
    await expect(history).toContainText(fixture.failingName);
    await expect(history).toContainText(fixture.alertedName);
  });

  test("workflow Properties: mute, unmute, customize with pause, reset", async ({
    page,
  }) => {
    const section = await openProperties(page, fixture.failingId);

    await section.getByRole("button", { name: "Mute", exact: true }).click();
    const mute = section.getByTestId("failure-alerts-mute");
    await expect(mute).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(mute).toHaveCount(0);
    await section.getByRole("button", { name: "Mute", exact: true }).click();
    await mute.getByRole("button", { name: "24 hours" }).click();
    await expect
      .poll(
        async () => (await readOverride(fixture.failingId))?.mutedUntil,
        SAVE_TIMEOUT
      )
      .toBeTruthy();
    await section.getByRole("button", { name: "Unmute" }).click();
    await expect
      .poll(
        async () => (await readOverride(fixture.failingId))?.mutedUntil ?? null,
        SAVE_TIMEOUT
      )
      .toBeNull();

    await section.getByRole("button", { name: CUSTOMIZE_LABEL }).click();
    const custom = section.getByTestId("failure-alerts-custom");
    await expect(custom).toBeVisible();
    const threshold = custom.locator("#wf-failure-threshold");
    const pauseBox = custom.locator("#wf-pause-workflow");
    await pauseBox.click();
    await threshold.fill("2");
    // Both edits are still in the draft when Save is pressed.
    await expect(threshold).toHaveValue("2");
    await expect(pauseBox).toHaveAttribute("data-state", "checked");
    await custom.getByRole("button", { name: "Save", exact: true }).click();
    await expect(custom).toHaveCount(0, SAVE_TIMEOUT);
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 2, pauseWorkflow: true });

    await section.getByRole("button", { name: RESET_LABEL }).click();
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toBeNull();
  });

  test("analytics lists the alert beside the runs", async ({ page }) => {
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    const table = page.getByTestId("runs-table");
    await expect(table).toHaveAttribute("data-ready", "true", FIRST_VISIT);
    // This workflow never ran, so its name only shows through its alert.
    await expect(table).toContainText(fixture.alertedName, SAVE_TIMEOUT);
  });

  for (const width of WIDTHS) {
    test(`no sideways scroll at ${width}px on Alerts and Properties`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1200 });
      await openAlerts(page);
      await expect(page.getByTestId("failure-alert-history")).toBeVisible();
      expect(
        await pageOverflow(page),
        "Alerts page overflow"
      ).toBeLessThanOrEqual(0);
      expect(
        await pastTheEdge(page, methodCards(page)),
        "method cards past the edge"
      ).toBe(0);

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
