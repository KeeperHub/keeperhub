import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { getAdminFetchHeaders } from "./admin-fetch";
import { getDbConnection } from "./connection";

/**
 * Navigate to accept-invite page and wait for it to render.
 * Uses the data-page-state attribute to deterministically wait for the page
 * to hydrate and compute its state, replacing the previous retry loop.
 */
export async function gotoAcceptInvite(
  page: Page,
  invitationId: string
): Promise<void> {
  const url = `/accept-invite/${invitationId}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-page-state]")).toBeAttached({
    timeout: 15_000,
  });
}

/**
 * Query the invitation table for the invite ID sent to an email.
 * Uses admin API when TEST_API_KEY + BASE_URL are set (remote/deployed mode).
 * Falls back to direct DB query with retry polling (local mode).
 */
export async function getInvitationIdFromDb(
  email: string,
  maxRetries = 10
): Promise<string> {
  const adminKey = process.env.TEST_API_KEY;
  const baseUrl = process.env.BASE_URL;

  if (adminKey && baseUrl) {
    return await getInvitationIdViaApi(email, baseUrl, maxRetries);
  }

  return await getInvitationIdViaDb(email, maxRetries);
}

async function getInvitationIdViaApi(
  email: string,
  baseUrl: string,
  maxRetries: number
): Promise<string> {
  const url = `${baseUrl}/api/admin/test/invitation?email=${encodeURIComponent(email)}`;

  const baseDelay = 500;
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, { headers: getAdminFetchHeaders() });
    if (response.ok) {
      const data = (await response.json()) as { invitationId: string };
      return data.invitationId;
    }
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(
        `Admin invitation API returned ${response.status}: ${body}`
      );
    }
    const delay = Math.min(baseDelay * 2 ** i, 4000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(
    `No invitation found for ${email} after ${maxRetries} retries via API`
  );
}

async function getInvitationIdViaDb(
  email: string,
  maxRetries: number
): Promise<string> {
  const sql = getDbConnection();
  try {
    for (let i = 0; i < maxRetries; i++) {
      const result = await sql`
        SELECT id FROM invitation
        WHERE email = ${email} AND status = 'pending'
        ORDER BY expires_at DESC
        LIMIT 1
      `;
      if (result.length > 0) {
        return result[0].id as string;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `No invitation found for ${email} after ${maxRetries} retries`
    );
  } finally {
    await sql.end();
  }
}

/**
 * Navigate to the invite form inside the Manage Organizations modal.
 * Waits for org switcher visibility before interacting.
 */
export async function openInviteForm(page: Page): Promise<void> {
  const orgSwitcher = page.locator('button[role="combobox"]');
  await expect(orgSwitcher).toBeVisible({ timeout: 15_000 });
  await orgSwitcher.click();

  await page.locator("text=Manage Organizations").click();

  const dialog = page.locator('[role="dialog"]');
  await expect(
    dialog.locator('h2:has-text("Manage Organizations")')
  ).toBeVisible({ timeout: 5000 });

  await dialog.locator('button:has-text("Manage")').first().click();

  await expect(
    dialog.locator('input[placeholder="colleague@example.com"]')
  ).toBeVisible({ timeout: 5000 });
}

/**
 * Send an invite from the current user and return the invitation ID.
 * Opens the invite form, fills the email, submits, and verifies success.
 */
export async function sendInvite(
  page: Page,
  inviteeEmail: string
): Promise<string> {
  await openInviteForm(page);

  const dialog = page.locator('[role="dialog"]');
  await dialog
    .locator('input[placeholder="colleague@example.com"]')
    .fill(inviteeEmail);

  const inviteButton = dialog.locator('button:has-text("Invite")');
  await expect(inviteButton).toBeEnabled({ timeout: 5000 });
  await inviteButton.click();

  const anyToast = page.locator("[data-sonner-toast]").first();
  await expect(anyToast).toBeVisible({ timeout: 15_000 });

  const successToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: `Invitation sent to ${inviteeEmail}` });
  await expect(successToast).toBeVisible({ timeout: 5000 });

  return getInvitationIdFromDb(inviteeEmail);
}
