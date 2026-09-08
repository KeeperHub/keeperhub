import { expect, test } from "./fixtures";
import { signUpAndVerify } from "./utils/auth";

// Force a fresh anonymous context — this test exercises the
// anonymous-user → auth-modal → magic-link → exactly-one-duplicate path.
test.use({ storageState: { cookies: [], origins: [] } });

const RE_WORKFLOWS_URL = /\/workflows\/[^/]+/;
const RE_DUPLICATE_PATH = /\/api\/workflows\/[^/]+\/duplicate$/;
const RE_LAX = /lax/i;
const RE_URL_DELIMS = /[/?#]/;

type PublicWorkflow = {
  id: string;
  name: string;
  isListed?: boolean;
};

test.describe("Anonymous Use-template flow (HUB-07)", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("anonymous click → AuthDialog → magic-link → exactly one duplicate", async ({
    page,
    context,
  }) => {
    // 1. Find a public listed workflow to use as the template source.
    //    /api/workflows/public returns an array of public workflows.
    const hubRes = await page.request.get("/api/workflows/public");
    if (!hubRes.ok()) {
      test.skip(
        true,
        `Public workflows endpoint unavailable (status ${hubRes.status()})`
      );
    }
    const workflows = (await hubRes.json()) as PublicWorkflow[];
    if (!workflows || workflows.length === 0) {
      test.skip(true, "No seeded public workflows; run pnpm db:seed");
    }
    const sourceWorkflow = workflows[0];
    if (!sourceWorkflow) {
      test.skip(true, "Public workflows response was empty");
      return;
    }

    // 2. Track ALL POST /api/workflows/{id}/duplicate requests.
    //    HUB-07 contract: exactly ONE fires per round-trip.
    const duplicateRequests: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && RE_DUPLICATE_PATH.test(req.url())) {
        duplicateRequests.push(req.url());
      }
    });

    // 3. Visit the workflow as an anonymous user.
    await page.goto(`/workflows/${sourceWorkflow.id}`, {
      waitUntil: "domcontentloaded",
    });

    // 4. Find and click the Use-template button (UI-SPEC analytics attribute).
    const useTemplateBtn = page.locator(
      'button[data-analytics="template_use_clicked"]'
    );
    await expect(useTemplateBtn).toBeVisible({ timeout: 15_000 });

    // 5. Listen for the cookie-set network call (POST /api/auth/template-intent).
    const intentReqPromise = page.waitForRequest(
      (req) =>
        req.url().endsWith("/api/auth/template-intent") &&
        req.method() === "POST"
    );

    await useTemplateBtn.click();
    const intentReq = await intentReqPromise;
    expect(intentReq.postDataJSON()).toEqual({
      workflowId: sourceWorkflow.id,
    });

    // 6. AuthDialog must be visible.
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // 7. Cookie set after the POST. The cookie is HttpOnly; Playwright's
    //    context.cookies() exposes HttpOnly cookies for inspection.
    const cookiesAfterClick = await context.cookies();
    const intentCookie = cookiesAfterClick.find(
      (c) => c.name === "pending_template"
    );
    expect(intentCookie?.value).toBe(sourceWorkflow.id);
    expect(intentCookie?.httpOnly).toBe(true);
    expect(intentCookie?.sameSite).toMatch(RE_LAX);

    // 8. Complete signup via the auth dialog (magic-link / OTP path).
    //    NOTE: Google OAuth in Playwright requires a real Google session;
    //    that path is documented as a deferred manual UAT step in plan 43-10.
    await signUpAndVerify(page);

    // 9. After signup, PendingTemplateRunner fires:
    //    - GET /api/auth/template-intent (returns workflowId, clears cookie)
    //    - router.refresh()
    //    - api.workflow.duplicate(workflowId)
    //    - router.push("/workflows/{newId}")
    //    - success toast (text asserted below)

    // Wait for the toast that confirms the duplicate succeeded.
    const successToast = page.locator(
      '[data-sonner-toast]:has-text("Template ready in your workflows")'
    );
    await expect(successToast).toBeVisible({ timeout: 30_000 });

    // 10. Exactly one duplicate request fired.
    expect(duplicateRequests).toHaveLength(1);

    // 11. URL is now a NEW workflow id (not the source).
    await page.waitForURL(RE_WORKFLOWS_URL, { timeout: 15_000 });
    const finalUrl = page.url();
    const finalId = finalUrl.split("/workflows/")[1]?.split(RE_URL_DELIMS)[0];
    expect(finalId).toBeTruthy();
    expect(finalId).not.toBe(sourceWorkflow.id);

    // 12. pending_template cookie is cleared after the GET runner consumed it.
    const cookiesAfterRun = await context.cookies();
    const cookieAfter = cookiesAfterRun.find(
      (c) => c.name === "pending_template"
    );
    // Either absent OR present with empty value (Max-Age=0 expires it).
    expect(cookieAfter?.value ?? "").toBe("");

    // 13. sessionStorage has the idempotency flag — a second mount within
    //     30s would NOT re-fire the duplicate (HUB-05).
    const sessionFlag = await page.evaluate(
      (id) => window.sessionStorage.getItem(`pending_template:${id}`),
      sourceWorkflow.id
    );
    expect(sessionFlag).toBeTruthy();
  });
});
