import type { Request } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";
import { getDbConnection } from "./utils/connection";

const ANALYTICS_EMAIL = "test-analytics@techops.services";
const ANALYTICS_PASSWORD = "TestAnalytics123!";
const RUN_ID_PREFIX = "e2e-refresh-";
const EXTRA_RUNS = 120;
const POLL_WAIT_MS = 25_000;

test.use({
  storageState: { cookies: [], origins: [] },
  timezoneId: "America/New_York",
});

function runsRequestPage(request: Request): string | null {
  return new URL(request.url()).searchParams.get("page");
}

function isRunsListRequest(request: Request): boolean {
  return new URL(request.url()).pathname === "/api/analytics/runs";
}

test.describe("Analytics periodic refresh", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const sql = getDbConnection();
    try {
      const [owner] = await sql`
        SELECT u.id AS user_id, m.organization_id
          FROM users u
          JOIN member m ON m.user_id = u.id
         WHERE u.email = ${ANALYTICS_EMAIL}
         LIMIT 1
      `;
      const [workflow] = await sql`
        SELECT id FROM workflows
         WHERE organization_id = ${owner.organization_id}
         LIMIT 1
      `;
      const now = Date.now();
      for (let i = 0; i < EXTRA_RUNS; i += 1) {
        const startedAt = new Date(now - (i + 1) * 60_000);
        await sql`
          INSERT INTO workflow_executions (
            id, workflow_id, user_id, status, started_at, completed_at,
            duration, total_steps, completed_steps
          ) VALUES (
            ${`${RUN_ID_PREFIX}${i}`}, ${workflow.id}, ${owner.user_id},
            'success', ${startedAt}, ${new Date(startedAt.getTime() + 1000)},
            '1000', '1', '1'
          )
        `;
      }
    } finally {
      await sql.end();
    }
  });

  test.afterAll(async () => {
    const sql = getDbConnection();
    try {
      await sql`
        DELETE FROM workflow_executions WHERE id LIKE ${`${RUN_ID_PREFIX}%`}
      `;
    } finally {
      await sql.end();
    }
  });

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("the refresh keeps the page the user moved to", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, ANALYTICS_EMAIL, ANALYTICS_PASSWORD);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });

    const table = page.getByTestId("runs-table");
    await expect(table).toHaveAttribute("data-ready", "true", {
      timeout: 15_000,
    });
    const pagination = table.locator('nav[aria-label="Pagination"]');
    await expect(pagination).toContainText("1–50 of");

    const runsRequests: Request[] = [];
    page.on("request", (request) => {
      if (isRunsListRequest(request)) {
        runsRequests.push(request);
      }
    });

    await pagination.locator("button").nth(1).click();
    await expect(pagination).toContainText("51–100 of");
    await expect(page).toHaveURL(/[?&]page=2\b/);
    const firstRowOnPage2 = await table.locator("tbody tr").first().innerText();

    await page.waitForTimeout(POLL_WAIT_MS);

    // The click made one request, and each refresh tick since made another.
    expect(runsRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of runsRequests) {
      expect(runsRequestPage(request)).toBe("2");
    }
    await expect(pagination).toContainText("51–100 of");
    await expect(page).toHaveURL(/[?&]page=2\b/);
    expect(await table.locator("tbody tr").first().innerText()).toBe(
      firstRowOnPage2
    );
  });

  test("a filter change sends the refresh back to page 1", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, ANALYTICS_EMAIL, ANALYTICS_PASSWORD);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });

    const table = page.getByTestId("runs-table");
    await expect(table).toHaveAttribute("data-ready", "true", {
      timeout: 15_000,
    });
    const pagination = table.locator('nav[aria-label="Pagination"]');
    await pagination.locator("button").nth(1).click();
    await expect(pagination).toContainText("51–100 of");

    const runsRequests: Request[] = [];
    page.on("request", (request) => {
      if (isRunsListRequest(request)) {
        runsRequests.push(request);
      }
    });

    await page
      .locator('nav[aria-label="Time range"] button:has-text("7d")')
      .click();
    await expect(pagination).toContainText("1–50 of");
    await expect(page).not.toHaveURL(/[?&]page=/);

    await page.waitForTimeout(POLL_WAIT_MS);

    expect(runsRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of runsRequests) {
      expect(runsRequestPage(request)).toBeNull();
    }
    await expect(pagination).toContainText("1–50 of");
  });

  test("the time-series and network facets answer in the viewer's zone", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const failures: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/analytics/") && !response.ok()) {
        failures.push(`${response.status()} ${url.pathname}`);
      }
    });

    await signIn(page, ANALYTICS_EMAIL, ANALYTICS_PASSWORD);
    const timeSeries = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/analytics/time-series"
    );
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });

    const timeSeriesResponse = await timeSeries;
    expect(new URL(timeSeriesResponse.url()).searchParams.get("tz")).toBe(
      "America/New_York"
    );
    const body = (await timeSeriesResponse.json()) as {
      buckets: unknown[];
      intervalMs: number;
    };
    // The window is filled bucket by bucket, quiet ones included.
    expect(body.intervalMs).toBeGreaterThan(0);
    expect(body.buckets.length).toBeGreaterThan(1);

    const facets = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/analytics/facets" &&
        url.searchParams.getAll("dimension").includes("network")
      );
    });
    await page.getByRole("button", { name: "Network" }).click();
    const facetsResponse = await facets;
    expect(facetsResponse.ok()).toBe(true);

    expect(failures).toEqual([]);
  });
});
