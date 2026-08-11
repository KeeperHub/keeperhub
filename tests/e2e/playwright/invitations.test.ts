import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  completeMfaSignInDialog,
  fillOtpInput,
  getOtpFromDb,
  signIn,
  signUp,
  signUpAndVerify,
} from "./utils/auth";
import {
  PERSISTENT_BYSTANDER_EMAIL,
  PERSISTENT_INVITER_EMAIL,
  PERSISTENT_MEMBER_EMAIL,
  PERSISTENT_TEST_PASSWORD,
} from "./utils/db";
import {
  gotoAcceptInvite,
  openInviteForm,
  sendInvite,
} from "./utils/invitations";

const ACCEPT_INVITE_URL_REGEX = /\/accept-invite/;

async function signInAsInviter(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const orgSwitcher = page.locator('button[role="combobox"]');
  // The inviter storage state usually leaves us already authenticated, so skip
  // the sign-in round-trip when the org switcher is already present. The bounded
  // wait avoids mistaking slow hydration for a logged-out state.
  const alreadySignedIn = await orgSwitcher
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (alreadySignedIn) {
    return;
  }
  await signIn(page, PERSISTENT_INVITER_EMAIL, PERSISTENT_TEST_PASSWORD);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(orgSwitcher).toBeVisible({ timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Organization Invitations", () => {
  // Reuse the inviter's authenticated session instead of signing in through the
  // UI on every test. Repeated credential sign-ins would otherwise exhaust the
  // per-email attempt budget mid-run. Tests that must act as a different
  // identity clear cookies first (INV-SEND-2, INV-RECV-2, ORG-1, ORG-3).
  test.use({ storageState: "tests/e2e/playwright/.auth/inviter.json" });

  test.describe("Sending Invites", () => {
    test("INV-SEND-1: invite new email shows success toast and confirmation", async ({
      page,
    }) => {
      await signInAsInviter(page);
      await openInviteForm(page);

      const dialog = page.locator('[role="dialog"]');
      const inviteEmail = `newinvitee+${Date.now()}@example.com`;

      await dialog
        .locator('input[placeholder="colleague@example.com"]')
        .fill(inviteEmail);
      await dialog.locator('button:has-text("Invite")').click();

      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: `Invitation sent to ${inviteEmail}` })
      ).toBeVisible({ timeout: 10_000 });

      await expect(dialog.locator("text=invited").first()).toBeVisible({
        timeout: 5000,
      });
    });

    test("INV-SEND-2: invite existing user shows success toast and confirmation", async ({
      page,
      context,
    }) => {
      // Inviter storage state is active; sign up the new user from a logged-out
      // state, then clear again before re-authenticating as the inviter.
      await context.clearCookies();
      const { email: existingUserEmail } = await signUp(page);
      await context.clearCookies();

      await signInAsInviter(page);
      await openInviteForm(page);

      const dialog = page.locator('[role="dialog"]');

      await dialog
        .locator('input[placeholder="colleague@example.com"]')
        .fill(existingUserEmail);
      await dialog.locator('button:has-text("Invite")').click();

      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: `Invitation sent to ${existingUserEmail}` })
      ).toBeVisible({ timeout: 10_000 });

      await expect(dialog.locator("text=invited").first()).toBeVisible({
        timeout: 5000,
      });
    });

    test("INV-SEND-3: re-inviting a pending email re-sends the invitation", async ({
      page,
    }) => {
      // The org plugin sets cancelPendingInvitationsOnReInvite: true
      // (lib/auth.ts), so re-inviting an email that already has a pending
      // invite cancels the old one and sends a fresh invite -- a success, not
      // an "already invited" rejection (the app emits no such toast).
      await signInAsInviter(page);
      await openInviteForm(page);

      const dialog = page.locator('[role="dialog"]');
      const inviteEmail = `reinvite+${Date.now()}@example.com`;
      const sentToast = page
        .locator("[data-sonner-toast]")
        .filter({ hasText: `Invitation sent to ${inviteEmail}` });

      // First invite succeeds.
      await dialog
        .locator('input[placeholder="colleague@example.com"]')
        .fill(inviteEmail);
      await dialog.locator('button:has-text("Invite")').click();
      await expect(sentToast).toBeVisible({ timeout: 10_000 });

      // Let the first toast clear so the re-invite toast is unambiguous.
      await expect(sentToast).toBeHidden({ timeout: 10_000 });

      // Re-inviting the same email re-sends (success), not an error.
      await dialog
        .locator('input[placeholder="colleague@example.com"]')
        .fill(inviteEmail);
      await dialog.locator('button:has-text("Invite")').click();
      await expect(sentToast).toBeVisible({ timeout: 10_000 });
    });

    test("INV-SEND-4: invite yourself shows already a member error toast", async ({
      page,
    }) => {
      await signInAsInviter(page);
      await openInviteForm(page);

      const dialog = page.locator('[role="dialog"]');

      await dialog
        .locator('input[placeholder="colleague@example.com"]')
        .fill(PERSISTENT_INVITER_EMAIL);
      await dialog.locator('button:has-text("Invite")').click();

      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: "already a member" })
      ).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe("Receiving Invites", () => {
    test("INV-RECV-1: accept invite as logged-out new user via signup and OTP", async ({
      page,
      context,
    }) => {
      await signInAsInviter(page);

      const inviteeEmail = `test+${Date.now()}@techops.services`;
      const invitationId = await sendInvite(page, inviteeEmail);
      await context.clearCookies();

      await gotoAcceptInvite(page, invitationId);

      await expect(page.locator("h1:has-text('Join')")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.locator('button:has-text("Create Account & Join")')
      ).toBeVisible();

      await page.locator("#password").fill("TestPassword123!");
      await page.locator('button:has-text("Create Account & Join")').click();

      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: "Account created" })
      ).toBeVisible({ timeout: 10_000 });

      await expect(
        page.locator("h1:has-text('Verify Your Email')")
      ).toBeVisible({ timeout: 10_000 });

      const otp = await getOtpFromDb(inviteeEmail);
      await fillOtpInput(page.locator("#otp"), otp);
      await page.locator('button:has-text("Verify & Join")').click();

      const welcomeToast = page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Welcome to" });
      const navigatedAway = page.waitForURL(
        (url) => !ACCEPT_INVITE_URL_REGEX.test(url.pathname),
        { timeout: 20_000 }
      );

      await Promise.race([
        welcomeToast.waitFor({ state: "visible", timeout: 20_000 }),
        navigatedAway,
      ]);

      await expect(page).not.toHaveURL(ACCEPT_INVITE_URL_REGEX, {
        timeout: 15_000,
      });
    });

    test("INV-RECV-2: accept invite as logged-out existing user via sign in", async ({
      page,
      context,
    }) => {
      const inviteeEmail = `test+${Date.now()}@techops.services`;
      // Inviter storage state is active; create the invitee from a logged-out
      // state first. The signup enrolls mandatory TOTP -- keep the setup key so
      // we can clear the sign-in step-up later.
      await context.clearCookies();
      const { password, totpKey } = await signUpAndVerify(page, {
        email: inviteeEmail,
      });
      await context.clearCookies();

      await signInAsInviter(page);
      const invitationId = await sendInvite(page, inviteeEmail);
      await context.clearCookies();

      await gotoAcceptInvite(page, invitationId);

      await expect(page.locator("h1:has-text('Join')")).toBeVisible({
        timeout: 15_000,
      });
      // The accept-invite page defaults to the create-account view; this
      // invitee already has an account, so switch to the sign-in view and open
      // the shared auth dialog, which runs the full three-factor sign-in. Scope
      // the toggle to the invite card's "Already have an account?" row so it
      // doesn't collide with the app-shell "Sign in" button.
      await page
        .locator("p", { hasText: "Already have an account?" })
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await page.locator('button:has-text("Sign In & Join")').click();

      await completeMfaSignInDialog(page, {
        email: inviteeEmail,
        password,
        totpKey,
      });

      // The dialog redirects back to the invite, now authenticated; accept it.
      const acceptButton = page.getByRole("button", {
        name: "Accept Invitation",
      });
      await expect(acceptButton).toBeVisible({ timeout: 20_000 });
      await acceptButton.click();

      await expect(page).not.toHaveURL(ACCEPT_INVITE_URL_REGEX, {
        timeout: 20_000,
      });
    });

    test("INV-RECV-3: accept invite while logged in as the correct user", async ({
      page,
      context,
    }) => {
      await signInAsInviter(page);
      const inviteeEmail = `test+${Date.now()}@techops.services`;
      const invitationId = await sendInvite(page, inviteeEmail);
      await context.clearCookies();

      await signUpAndVerify(page, { email: inviteeEmail });

      await gotoAcceptInvite(page, invitationId);

      await expect(page.locator("h1:has-text('Join')")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("text=You're signed in as")).toBeVisible();
      await expect(
        page.locator('button:has-text("Accept Invitation")')
      ).toBeVisible();

      await page.locator('button:has-text("Accept Invitation")').click();

      const welcomeToast = page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Welcome to" });
      const navigatedAway = page.waitForURL(
        (url) => !ACCEPT_INVITE_URL_REGEX.test(url.pathname),
        { timeout: 20_000 }
      );

      await Promise.race([
        welcomeToast.waitFor({ state: "visible", timeout: 20_000 }),
        navigatedAway,
      ]);

      await expect(page).not.toHaveURL(ACCEPT_INVITE_URL_REGEX, {
        timeout: 15_000,
      });
    });

    test("INV-RECV-4: accept invite while logged in as a different user shows mismatch", async ({
      page,
      context,
    }) => {
      await signInAsInviter(page);
      const inviteeEmail = `test+${Date.now()}@techops.services`;
      const invitationId = await sendInvite(page, inviteeEmail);
      await context.clearCookies();

      // Sign in as persistent bystander (wrong user)
      await signIn(page, PERSISTENT_BYSTANDER_EMAIL, PERSISTENT_TEST_PASSWORD);

      await gotoAcceptInvite(page, invitationId);

      await expect(page.locator("h1:has-text('Wrong Account')")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("text=This invitation is for")).toBeVisible();
      await expect(
        page.locator("text=You're currently signed in as")
      ).toBeVisible();

      await page.locator('button:has-text("Sign Out & Continue")').click();

      await expect(page.locator("h1:has-text('Join')")).toBeVisible({
        timeout: 15_000,
      });
    });
  });

  test.describe("Organization Membership", () => {
    test("ORG-1: user can switch between multiple orgs", async ({
      page,
      context,
    }) => {
      // Inviter storage state is active; sign in as the member from a
      // logged-out state.
      await context.clearCookies();
      // Persistent member is already in 2 orgs (own + inviter's) from seed
      await signIn(page, PERSISTENT_MEMBER_EMAIL, PERSISTENT_TEST_PASSWORD);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });

      const orgSwitcher = page.locator('button[role="combobox"]');
      const currentOrgName = await orgSwitcher.innerText();
      await orgSwitcher.click();

      const popover = page.locator('[role="listbox"]');
      await expect(popover).toBeVisible({ timeout: 5000 });
      const orgItems = popover.locator('[role="option"]');
      await expect(orgItems).toHaveCount(3); // 2 orgs + "Manage Organizations"

      const activeItem = orgItems.filter({ hasText: currentOrgName.trim() });
      await expect(activeItem.locator("svg.opacity-100")).toBeVisible();

      const otherOrg = orgItems
        .filter({ hasNotText: currentOrgName.trim() })
        .filter({ hasNotText: "Manage Organizations" })
        .first();
      const otherOrgName = await otherOrg.innerText();
      await otherOrg.click();

      await expect(orgSwitcher).toContainText(otherOrgName.trim(), {
        timeout: 10_000,
      });
    });

    test("ORG-2: accepting invite to second org shows new org in switcher", async ({
      page,
      context,
    }) => {
      // Persistent inviter sends invite to ephemeral user
      await signInAsInviter(page);
      const inviteeEmail = `test+${Date.now()}@techops.services`;
      const invitationId = await sendInvite(page, inviteeEmail);
      await context.clearCookies();

      // Ephemeral invitee signs up (gets their own org)
      await signUpAndVerify(page, { email: inviteeEmail });

      await gotoAcceptInvite(page, invitationId);
      await expect(
        page.locator('button:has-text("Accept Invitation")')
      ).toBeVisible({ timeout: 15_000 });
      await page.locator('button:has-text("Accept Invitation")').click();

      const welcomeToast = page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Welcome to" });
      const notOnAcceptPage = page.waitForURL(
        (url) => !url.pathname.includes("accept-invite"),
        { timeout: 15_000 }
      );
      await Promise.race([
        welcomeToast
          .waitFor({ state: "visible", timeout: 15_000 })
          .catch(() => {
            /* intentional noop */
          }),
        notOnAcceptPage.catch(() => {
          /* intentional noop */
        }),
      ]);

      await page.goto("/", { waitUntil: "domcontentloaded" });
      const orgSwitcher = page.locator('button[role="combobox"]');
      await expect(orgSwitcher).toBeVisible({ timeout: 15_000 });
      await orgSwitcher.click();

      const popover = page.locator('[role="listbox"]');
      await expect(popover).toBeVisible({ timeout: 5000 });
      const orgItems = popover.locator('[role="option"]');
      await expect(orgItems).toHaveCount(3);
    });

    test("ORG-3: user can leave an org", async ({ page, context }) => {
      // Inviter storage state is active; sign in as the member from a
      // logged-out state.
      await context.clearCookies();
      // Persistent member is in 2 orgs from seed
      await signIn(page, PERSISTENT_MEMBER_EMAIL, PERSISTENT_TEST_PASSWORD);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });

      const orgSwitcher = page.locator('button[role="combobox"]');
      await orgSwitcher.click();
      await page.locator("text=Manage Organizations").click();

      const dialog = page.locator('[role="dialog"]');
      await expect(
        dialog.locator('h2:has-text("Manage Organizations")')
      ).toBeVisible({ timeout: 5000 });

      const orgCards = dialog.locator(
        ".flex.items-center.justify-between.rounded-lg.border.p-3"
      );
      const memberOrg = orgCards
        .filter({ has: page.locator("p.capitalize", { hasText: "Member" }) })
        .first();
      const orgNameToLeave = await memberOrg
        .locator(".font-medium.text-sm")
        .first()
        .innerText();
      await memberOrg.locator('button:has-text("Manage")').click();

      await dialog.locator('button:has-text("Leave Organization")').click();

      const alertDialog = page.locator('[role="alertdialog"]');
      await expect(alertDialog).toBeVisible({ timeout: 5000 });
      await expect(
        alertDialog.locator("text=Are you sure you want to leave")
      ).toBeVisible();

      await alertDialog
        .locator('button:has-text("Leave Organization")')
        .click();

      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: `Left ${orgNameToLeave}` })
      ).toBeVisible({ timeout: 10_000 });
    });
  });
});
