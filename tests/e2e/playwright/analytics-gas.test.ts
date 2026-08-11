import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";

const ANALYTICS_EMAIL = "test-analytics@techops.services";
const ANALYTICS_PASSWORD = "TestAnalytics123!";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Analytics Gas Tracking", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("Gas Spent KPI card shows non-zero value", async ({ page }) => {
    await signIn(page, ANALYTICS_EMAIL, ANALYTICS_PASSWORD);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });

    // Switch to 7d range (seed data spans 7 days)
    const rangeButton = page.locator(
      'nav[aria-label="Time range"] button:has-text("7d")'
    );
    await rangeButton.click();

    // Wait for KPI cards to finish loading
    await expect(page.getByTestId("kpi-cards")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15_000 }
    );

    // Headline value is wallet-paid plus sponsored gas for the range
    const gasCard = page.locator('[data-kpi="gas-spent"]');
    await expect(gasCard).toBeVisible({ timeout: 10_000 });

    const gasValue = gasCard.getByTestId("kpi-value");
    await expect(gasValue).toBeVisible();
    await expect(gasValue).not.toHaveText("0 ETH", { timeout: 10_000 });
  });

  test("workflow runs table loads with data", async ({ page }) => {
    await signIn(page, ANALYTICS_EMAIL, ANALYTICS_PASSWORD);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });

    // Switch to 7d range
    await page
      .locator('nav[aria-label="Time range"] button:has-text("7d")')
      .click();

    // Wait for runs table to finish loading
    await expect(page.getByTestId("runs-table")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15_000 }
    );

    // Filter by workflow source
    const workflowFilter = page.locator(
      'nav[aria-label="Source"] button:has-text("Workflow")'
    );
    await workflowFilter.click();

    // Wait for table to reload after filter
    await expect(page.getByTestId("runs-table")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 15_000 }
    );

    // Table rows
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    // Verify at least one workflow run row exists
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test("network breakdown API includes workflow gas", async ({ page }) => {
    await signIn(page, ANALYTICS_EMAIL, ANALYTICS_PASSWORD);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });

    // Hit the networks endpoint directly via the page context (inherits auth cookies)
    const response = await page.request.get("/api/analytics/networks?range=7d");
    const responseBody = await response.text();
    expect(
      response.ok(),
      `Networks API returned ${response.status()}: ${responseBody}`
    ).toBe(true);

    const data = await response.json();
    expect(data.networks.length).toBeGreaterThan(0);

    // Seed data uses chain IDs 1, 137, 8453, 11155111 for workflow gas
    const networkIds = data.networks.map((n: { network: string }) => n.network);

    // At least one workflow chain ID should be present
    const workflowChainIds = ["1", "137", "8453", "11155111"];
    const hasWorkflowNetwork = workflowChainIds.some((id) =>
      networkIds.includes(id)
    );
    expect(hasWorkflowNetwork).toBe(true);

    // Gas is recorded only when an execution completes, so networks that saw
    // only failed or pending runs legitimately report zero gas (matches the
    // production write path). Assert gas is attributed overall, and that any
    // network with successful executions carries non-zero gas.
    let totalGasAcrossNetworks = BigInt(0);
    for (const network of data.networks) {
      const gas = BigInt(network.totalGasWei);
      totalGasAcrossNetworks += gas;
      if (network.successCount > 0) {
        expect(
          gas,
          `network ${network.network} has successful executions but zero gas`
        ).toBeGreaterThan(BigInt(0));
      }
    }
    expect(totalGasAcrossNetworks).toBeGreaterThan(BigInt(0));
  });

  test("workflow runs API attaches gas to the returned page", async ({
    page,
  }) => {
    await signIn(page, ANALYTICS_EMAIL, ANALYTICS_PASSWORD);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });

    const response = await page.request.get(
      "/api/analytics/runs?range=7d&source=workflow"
    );
    const responseBody = await response.text();
    expect(
      response.ok(),
      `Runs API returned ${response.status()}: ${responseBody}`
    ).toBe(true);

    const data = JSON.parse(responseBody) as {
      runs: { source: string; gasUsedWei: string | null }[];
      total: number;
      pageSize: number;
    };

    // Pagination metadata is present and the page is non-empty.
    expect(data.pageSize).toBeGreaterThan(0);
    expect(data.runs.length).toBeGreaterThan(0);

    // The source filter is honoured for every returned row.
    for (const run of data.runs) {
      expect(run.source).toBe("workflow");
    }

    // Gas is now aggregated only for the executions on this page (the
    // log_summary subquery is scoped to the paged execution IDs). At least one
    // seeded web3-write run must still carry non-zero gas - this is what would
    // regress if the page-scoped aggregation dropped or mis-joined gas.
    const withGas = data.runs.filter(
      (r) => r.gasUsedWei !== null && r.gasUsedWei !== "0"
    );
    expect(withGas.length).toBeGreaterThan(0);
    for (const run of withGas) {
      expect(BigInt(run.gasUsedWei as string)).toBeGreaterThan(BigInt(0));
    }
  });
});
