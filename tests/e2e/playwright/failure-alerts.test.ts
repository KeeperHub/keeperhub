import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";
import {
  type AlertsFixture,
  addFailedDelivery,
  cleanupFailureAlerts,
  clearOrgPause,
  countMethods,
  readOrgPause,
  readOrgThreshold,
  readOverride,
  seedFailureAlerts,
  setOrgThreshold,
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
    // Setup problems and workflow problems are two lists of the same shape.
    const setupIssues = page.getByTestId("failure-alerts-setup-issues");
    await expect(setupIssues).toBeVisible();
    // The seeded Telegram method was stopped by a failed delivery.
    await expect(setupIssues).toContainText("1 method needs attention");
    const workflows = page.getByTestId("failure-alerts-failing");
    await expect(workflows).toContainText(fixture.failingName);
    // "Alert sent ... ago" lives in the workflow row only.
    await expect(workflows).toContainText("alert sent");
    await expect(page.getByText("Last alert delivered")).toHaveCount(0);
    await expect(page.getByText(/Alerts reach/)).toHaveCount(0);
    await page.getByTestId("failure-alerts-tab-sent").click();
    await expect(page).toHaveURL(/[?&]tab=sent/);
    await expect(page.getByTestId("failure-alert-history")).toBeVisible();
  });

  test("Setup shows who gets alerts, then the rules", async ({ page }) => {
    await openAlerts(page);
    // The only recipient, the owner, cannot be unticked.
    const email = methodCard(page, "email");
    await email.getByRole("button", { name: "Edit" }).click();
    const only = email.getByRole("checkbox").first();
    await expect(only).toBeChecked();
    await expect(only).toBeDisabled();
    await expect(
      email.getByTestId("failure-alerts-last-recipient")
    ).toBeVisible();
    await email.getByRole("button", { name: "Close" }).click();
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
    // The seeded Telegram method was stopped by a failed delivery.
    await expect(methodCard(page, "telegram")).toHaveAttribute(
      "data-status",
      "stopped"
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

  test("Sent alerts filters by workflow name or ID", async ({ page }) => {
    await openAlerts(page, "sent");
    const rows = page.getByTestId("failure-alert-history-row");
    await expect(rows.first()).toBeVisible(FIRST_VISIT);
    await page.getByTestId("failure-alert-history-filters-toggle").click();
    const filter = page.getByTestId("failure-alert-history-workflow-filter");
    await filter.fill(fixture.alertedName);
    await expect(rows.filter({ hasText: fixture.failingName })).toHaveCount(
      0,
      SAVE_TIMEOUT
    );
    await expect(rows.filter({ hasText: fixture.alertedName })).not.toHaveCount(
      0
    );
    // By ID too, so a renamed workflow's old alerts stay findable.
    await filter.fill(fixture.failingId);
    await expect(rows.filter({ hasText: fixture.alertedName })).toHaveCount(
      0,
      SAVE_TIMEOUT
    );
    await expect(rows.filter({ hasText: fixture.failingName })).not.toHaveCount(
      0
    );
  });

  test("workflow Properties: pause, resume, custom rules tab with pause, back to org rules", async ({
    page,
  }) => {
    let section = await openProperties(page, fixture.failingId);

    const pauseOpen = section.getByTestId("failure-alerts-workflow-pause-open");
    await expect(section).toHaveAttribute("data-source", "org");
    // One pause for the whole workflow, outside the rules tabs, on either tab.
    const rulesCard = section.getByTestId("failure-alerts-rules-card");
    for (const tab of ["org", "custom"] as const) {
      await section.getByTestId(`failure-alerts-tab-${tab}`).click();
      await expect(pauseOpen).toHaveCount(1);
      await expect(
        rulesCard.getByTestId("failure-alerts-workflow-pause-open")
      ).toHaveCount(0);
      await expect(
        section
          .getByTestId("failure-alerts-workflow-pause-area")
          .getByTestId("failure-alerts-workflow-pause-open")
      ).toHaveCount(1);
    }
    await section.getByTestId("failure-alerts-tab-org").click();
    await pauseOpen.click();
    const pause = section.getByTestId("failure-alerts-workflow-pause");
    await expect(pause).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pause).toHaveCount(0);
    await pauseOpen.click();
    // A pause needs a length and a reason; nothing saves until both are given.
    await pause.locator('[data-pause="24h"]').click();
    const submit = pause.getByTestId("failure-alerts-workflow-pause-submit");
    await expect(submit).toBeDisabled();
    await pause
      .getByTestId("failure-alerts-workflow-pause-reason")
      .fill("E2E RPC move");
    await submit.click();
    await expect
      .poll(
        async () => (await readOverride(fixture.failingId))?.pausedUntil,
        SAVE_TIMEOUT
      )
      .toBeTruthy();
    await expect(section).toHaveAttribute("data-paused", "true");
    await expect(section).toContainText("E2E RPC move");

    // The pause is never quiet: Needs attention lists it, Sent alerts logs it.
    await openAlerts(page, "overview");
    const pausedRow = page.getByTestId("failure-alerts-workflow-alerts-paused");
    await expect(pausedRow).toContainText(fixture.failingName, FIRST_VISIT);
    await expect(pausedRow).toContainText("E2E RPC move");
    await expect(page.getByText("All healthy")).toHaveCount(0);
    await openAlerts(page, "sent");
    await expect(
      page
        .getByTestId("failure-alert-history-row")
        .and(page.locator('[data-kind="workflow_alerts_paused"]'))
        .filter({ hasText: fixture.failingName })
    ).toHaveCount(1, SAVE_TIMEOUT);

    section = await openProperties(page, fixture.failingId);
    await section.getByTestId("failure-alerts-workflow-resume").click();
    await expect
      .poll(
        async () =>
          (await readOverride(fixture.failingId))?.pausedUntil ?? null,
        SAVE_TIMEOUT
      )
      .toBeNull();

    await expect(section).toHaveAttribute("data-paused", "false");
    // Both tabs show Rules, Email and Methods; a tab only shows, its button switches.
    await expect(section.getByTestId("failure-alerts-tab-org")).toHaveAttribute(
      "data-state",
      "active"
    );
    await expect(section.getByTestId("failure-alerts-in-use")).toBeVisible();
    // Org rules read like Settings > Alerts, reminders and recovery included.
    const orgView = section.getByTestId("failure-alerts-rules-view");
    await expect(orgView.locator("h3")).toHaveText([
      "Who gets alerts",
      "When to alert",
    ]);
    await expect(orgView).toContainText(
      "Remind once a day while it keeps failing"
    );
    await expect(orgView).toContainText("Tell people when it works again");
    // One link to the org rules, under the card, straight to Setup.
    const orgLinks = section.getByRole("link", {
      name: /Settings|Org alert rules/,
    });
    await expect(orgLinks).toHaveCount(1);
    await expect(orgLinks).toHaveAttribute("href", /\/alerts\?tab=setup$/);
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
    // Laid out like Settings > Alerts: who gets alerts, then when.
    await expect(custom.locator("h3")).toHaveText([
      "Who gets alerts",
      "When to alert",
    ]);
    // No Save or Cancel of its own: edits save themselves.
    await expect(custom.getByRole("button", { name: "Save" })).toHaveCount(0);
    const threshold = custom.locator("#wf-failure-threshold");
    await expect(threshold).toHaveValue("5");
    const disableBox = custom.locator("#wf-disable-workflow");
    await disableBox.click();
    await threshold.fill("2");
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 2, disableWorkflow: true });
    await expect(section.getByTestId("failure-alerts-autosave")).toHaveText(
      "All changes saved",
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

  test("Sent alerts: switch, not-delivered button, empty state, whole emails", async ({
    page,
  }) => {
    await addFailedDelivery(fixture.orgId, fixture.email);
    await openAlerts(page, "sent");
    const rows = page.getByTestId("failure-alert-history-row");
    await expect(rows.first()).toBeVisible(FIRST_VISIT);

    // People's actions shows the earlier pause and none of the alerts.
    await page.getByTestId("failure-alert-history-scope-people").click();
    await expect(
      rows.and(page.locator('[data-kind="workflow_alerts_paused"]')).first()
    ).toBeVisible(SAVE_TIMEOUT);
    await expect(rows.and(page.locator('[data-kind="alert"]'))).toHaveCount(0);
    await expect(rows.filter({ hasText: "Reason:" }).first()).toBeVisible();
    await page.getByTestId("failure-alert-history-scope-alerts").click();

    // The not-delivered count filters to those rows, and back.
    const notDelivered = page.getByTestId(
      "failure-alert-history-not-delivered"
    );
    await expect(notDelivered).toContainText("1 not delivered", SAVE_TIMEOUT);
    await notDelivered.click();
    await expect(notDelivered).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(1, SAVE_TIMEOUT);
    await expect(rows.first()).toHaveAttribute("data-state", "failed");
    await notDelivered.click();
    await expect(rows.first()).toBeVisible();

    // A filter that matches nothing says so inside the table, with a way out.
    await page.getByTestId("failure-alert-history-filters-toggle").click();
    await page
      .getByTestId("failure-alert-history-workflow-filter")
      .fill("no-such-workflow-anywhere");
    const empty = page.getByTestId("failure-alert-history-empty");
    await expect(empty).toContainText(
      "No messages match these filters.",
      SAVE_TIMEOUT
    );
    await expect(empty).toContainText(
      "Organization-wide pause notices and tests are hidden."
    );
    await empty.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows.first()).toBeVisible(SAVE_TIMEOUT);

    // An email is never split inside a word: each half stays on one line.
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const tab of ["sent", "setup"] as const) {
        await openAlerts(page, tab);
        if (tab === "setup") {
          // The recipient picker lives inside the Email card.
          await methodCard(page, "email")
            .getByRole("button", { name: "Edit" })
            .click();
        }
        await expect(
          page.locator("[data-email-part]:visible").first()
        ).toBeVisible(FIRST_VISIT);
        // An inline-block is one box even when it wraps, so measure its height.
        const wrapped = await page.locator("[data-email-part]").evaluateAll(
          (parts) =>
            parts.filter((p) => {
              const box = p.getBoundingClientRect();
              const line = Number.parseFloat(getComputedStyle(p).lineHeight);
              return box.width > 0 && box.height > line * 1.5;
            }).length
        );
        expect(wrapped, `${tab} at ${width}px`).toBe(0);
      }
    }
  });

  test("workflow Properties: own email and methods use the Settings cards", async ({
    page,
  }) => {
    const section = await openProperties(page, fixture.alertedId);
    await section.getByTestId("failure-alerts-tab-custom").click();
    await section.getByTestId("failure-alerts-use-custom").click();
    const custom = section.getByTestId("failure-alerts-custom");
    await expect(custom).toBeVisible(SAVE_TIMEOUT);

    // Email: the Settings card, open, with the owner locked in as the last recipient.
    await custom.locator("#wf-own-recipients").click();
    const email = custom
      .getByTestId("wf-email-card")
      .getByTestId("failure-alert-method");
    await expect(email).toHaveAttribute("data-kind", "email");
    await expect(
      email.getByRole("button", { name: "Test Email" })
    ).toBeVisible();
    const only = email.getByRole("checkbox").first();
    await expect(only).toBeChecked();
    await expect(only).toBeDisabled();
    await expect(
      email.getByTestId("failure-alerts-last-recipient")
    ).toBeVisible();

    // Methods: the owner's unshared connection is listed greyed out, as in Settings.
    await custom.locator("#wf-own-channels").click();
    await expect
      .poll(
        async () => (await readOverride(fixture.alertedId))?.customChannels,
        SAVE_TIMEOUT
      )
      .toBe(true);
    const telegram = custom
      .getByTestId("failure-alert-method")
      .and(page.locator('[data-kind="telegram"]'));
    // Copied paused, so the card opens by itself.
    await telegram.getByLabel("Connection").click();
    await expect(
      page.getByRole("option", {
        name: `${fixture.privateTelegramName} (not shared with the organization)`,
      })
    ).toBeDisabled();
    await page.keyboard.press("Escape");

    // A Test of a stored method reloads its health from the server.
    const reload = page.waitForRequest(
      (req) =>
        req.method() === "GET" &&
        req.url().endsWith(`/api/workflows/${fixture.alertedId}/failure-alerts`)
    );
    await telegram.getByRole("button", { name: /^Test / }).click();
    await reload;

    await section.getByTestId("failure-alerts-tab-org").click();
    await section.getByTestId("failure-alerts-reset").click();
    await expect
      .poll(() => readOverride(fixture.alertedId), SAVE_TIMEOUT)
      .toBeNull();
  });

  test("workflow Properties: leaving inside the autosave delay asks first, and the edit is saved either way", async ({
    page,
  }) => {
    const section = await openProperties(page, fixture.alertedId);
    await section.getByTestId("failure-alerts-tab-custom").click();
    await section.getByTestId("failure-alerts-use-custom").click();
    await expect
      .poll(() => readOverride(fixture.alertedId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 5 });
    await section.locator("#wf-failure-threshold").fill("7");
    // Inside the autosave delay a reload asks first; staying, the edit is saved.
    let asked = false;
    page.once("dialog", (dialog) => {
      asked = dialog.type() === "beforeunload";
      dialog.dismiss().catch(() => undefined);
    });
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 3000 })
      .catch(() => undefined);
    expect(asked).toBe(true);
    await expect
      .poll(() => readOverride(fixture.alertedId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 7 });

    // Closing the tab anyway: the save sent at the prompt still lands.
    await section.locator("#wf-failure-threshold").fill("8");
    page.once("dialog", (dialog) => {
      dialog.accept().catch(() => undefined);
    });
    const context = page.context();
    await page.close({ runBeforeUnload: true });
    await expect
      .poll(() => readOverride(fixture.alertedId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 8 });

    const next = await context.newPage();
    const after = await openProperties(next, fixture.alertedId);
    await after.getByTestId("failure-alerts-tab-org").click();
    await after.getByTestId("failure-alerts-reset").click();
    await expect
      .poll(() => readOverride(fixture.alertedId), SAVE_TIMEOUT)
      .toBeNull();
  });

  test("Overview resumes a workflow's paused alerts in one click", async ({
    page,
  }) => {
    const section = await openProperties(page, fixture.failingId);
    await section.getByTestId("failure-alerts-workflow-pause-open").click();
    const pause = section.getByTestId("failure-alerts-workflow-pause");
    await pause.locator('[data-pause="1h"]').click();
    await pause
      .getByTestId("failure-alerts-workflow-pause-reason")
      .fill("E2E quick fix");
    await pause.getByTestId("failure-alerts-workflow-pause-submit").click();
    await expect
      .poll(
        async () => (await readOverride(fixture.failingId))?.pausedUntil,
        SAVE_TIMEOUT
      )
      .toBeTruthy();
    try {
      await openAlerts(page, "overview");
      const pausedRow = page.getByTestId(
        "failure-alerts-workflow-alerts-paused"
      );
      await expect(pausedRow).toContainText("E2E quick fix", FIRST_VISIT);
      await pausedRow.getByTestId("failure-alerts-overview-resume").click();
      await expect
        .poll(
          async () =>
            (await readOverride(fixture.failingId))?.pausedUntil ?? null,
          SAVE_TIMEOUT
        )
        .toBeNull();
      await expect(pausedRow).toHaveCount(0, SAVE_TIMEOUT);
    } finally {
      // Leave the shared fixture resumed even if a step above failed.
      const left = await openProperties(page, fixture.failingId);
      const resume = left.getByTestId("failure-alerts-workflow-resume");
      if ((await resume.count()) > 0) {
        await resume.click();
      }
    }
  });

  test("workflow Properties: unfinished rules never block Save, the tab holds, and leaving saves", async ({
    page,
  }) => {
    const section = await openProperties(page, fixture.failingId);
    await section.getByTestId("failure-alerts-tab-custom").click();
    await section.getByTestId("failure-alerts-use-custom").click();
    await expect(section).toHaveAttribute(
      "data-source",
      "custom",
      SAVE_TIMEOUT
    );
    const threshold = section.locator("#wf-failure-threshold");
    const status = section.getByTestId("failure-alerts-autosave");

    // An unfinished draft never blocks the workflow's Save, and stays marked unsaved.
    await threshold.fill("0");
    await expect(status).toContainText("Not saved");
    const save = page.getByRole("button", { name: "Save workflow" });
    const unsavedDot = save.getByTestId("workflow-unsaved-dot");
    await expect(unsavedDot).toHaveCount(1);
    await save.click();
    // Named "Saving..." while it runs; back to "Save workflow" once done.
    await expect(save).toBeEnabled(SAVE_TIMEOUT);
    await expect(page.getByText("Failed to save workflow")).toHaveCount(0);
    await expect(unsavedDot).toHaveCount(1);
    await expect(status).toContainText("fix the number of failed runs");

    // Looking at the org rules while an edit saves keeps the org rules on screen.
    await threshold.fill("3");
    await section.getByTestId("failure-alerts-tab-org").click();
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 3 });
    await page.waitForTimeout(500);
    await expect(section.getByTestId("failure-alerts-tab-org")).toHaveAttribute(
      "data-state",
      "active"
    );

    // Picking a node right after an edit unmounts the panel; the edit still saves.
    await section.getByTestId("failure-alerts-tab-custom").click();
    await threshold.fill("4");
    await page.locator(".react-flow__node").first().click();
    await expect(page.getByTestId("workflow-failure-alerts")).toHaveCount(0);
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toMatchObject({ threshold: 4 });

    const again = await openProperties(page, fixture.failingId);
    await again.getByTestId("failure-alerts-tab-org").click();
    await again.getByTestId("failure-alerts-reset").click();
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toBeNull();
  });

  test("workflow Properties: Use org rules is not undone by an immediate Save", async ({
    page,
  }) => {
    const section = await openProperties(page, fixture.failingId);
    await section.getByTestId("failure-alerts-tab-custom").click();
    await section.getByTestId("failure-alerts-use-custom").click();
    await expect(section).toHaveAttribute(
      "data-source",
      "custom",
      SAVE_TIMEOUT
    );
    await section.locator("#wf-failure-threshold").fill("6");
    // Hold the reset in flight so Save lands while it is still pending.
    await page.route("**/api/workflows/*/failure-alerts", async (route) => {
      const body = route.request().postData() ?? "";
      if (route.request().method() === "PUT" && !body.includes("threshold")) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });
    await section.getByTestId("failure-alerts-tab-org").click();
    await section.getByTestId("failure-alerts-reset").click();
    await page.getByRole("button", { name: "Save workflow" }).click();
    await expect(section).toHaveAttribute("data-source", "org", SAVE_TIMEOUT);
    await page.unroute("**/api/workflows/*/failure-alerts");
    await expect
      .poll(() => readOverride(fixture.failingId), SAVE_TIMEOUT)
      .toBeNull();
  });

  test("an invalid rule says it is not saved, and the saved toast goes", async ({
    page,
  }) => {
    await openAlerts(page);
    const threshold = page.locator("#failure-threshold");
    const status = page.getByTestId("failure-alerts-rules-autosave");
    try {
      await threshold.fill("4");
      await expect(status).toHaveText("Saved", SAVE_TIMEOUT);
      await threshold.fill("0");
      await expect(status).toHaveText(
        "Not saved: fix the number of failed runs"
      );
      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: "Alert rules saved" })
      ).toHaveCount(0);
      expect(await readOrgThreshold(fixture.orgId)).toBe(4);
    } finally {
      await setOrgThreshold(fixture.orgId, 5);
    }
  });

  test("a saved change from elsewhere is kept, not overwritten by a clean draft", async ({
    page,
  }) => {
    await openAlerts(page, "overview");
    const toggle = page.getByTestId("failure-alerts-switch");
    await toggle.click();
    const form = page.getByTestId("failure-alerts-pause-form");
    await form.getByTestId("failure-alerts-pause-submit").click();
    await expect(page.getByTestId("failure-alerts-paused")).toBeVisible(
      SAVE_TIMEOUT
    );
    try {
      // Another admin changes the threshold; resuming brings the new settings in.
      await setOrgThreshold(fixture.orgId, 7);
      await toggle.click();
      await expect(page.getByTestId("failure-alerts-paused")).toHaveCount(
        0,
        SAVE_TIMEOUT
      );
      await page.waitForTimeout(2500);
      expect(await readOrgThreshold(fixture.orgId)).toBe(7);
      await page.getByTestId("failure-alerts-tab-setup").click();
      await expect(page.locator("#failure-threshold")).toHaveValue("7");
    } finally {
      await setOrgThreshold(fixture.orgId, 5);
      await clearOrgPause(fixture.orgId);
    }
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
