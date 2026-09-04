import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import {
  anonymous,
  captcha,
  deviceAuthorization,
  emailOTP,
  organization,
  siwe,
  twoFactor,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateSiweNonce } from "viem/siwe";
import { recordWalletInAddressBook } from "@/lib/address-book/record-wallet";
import { rateLimitBypassRule, testEndpointsEnabled } from "@/lib/admin-auth";
import { verifySiweSignature } from "@/lib/auth/siwe-verify";
import {
  isWalletEmail,
  WALLET_EMAIL_DOMAIN,
} from "@/lib/auth/wallet-constants";
import { isUserDeactivated } from "@/lib/auth-deactivation-guard";
import { isDisposableEmailDomain } from "@/lib/auth-disposable-emails";
import { DISPOSABLE_EMAIL_REJECTION_MESSAGE } from "@/lib/auth-disposable-emails-message";
import { isFreshSignup } from "@/lib/auth-notification-guard";
import {
  claimSignupNotification,
  resolveSignupMethod,
  type SignupMethod,
} from "@/lib/auth-signup-notification";
import { sendInvitationEmail, sendVerificationOTP } from "@/lib/email";
import { hasValidLoadTestBypass } from "@/lib/load-test-bypass";
import {
  ErrorCategory,
  logSecurityEvent,
  logSystemError,
  logSystemWarn,
  logUserError,
  logWarn,
} from "@/lib/logging";
import { revokeRefreshTokensForUserOrg } from "@/lib/mcp/oauth-store";
import { recordAuditEvent } from "@/lib/security/audit-log";
import {
  CLIENT_IP_HEADERS,
  CLIENT_IP_TRUSTED_PROXIES,
} from "@/lib/security/client-ip";
import {
  assessCountryTrust,
  assessLoginRisk,
  serializeRiskFlags,
  upsertTrustedCountry,
} from "@/lib/security/login-risk";
import { reportSessionBackstop } from "@/lib/security/session-backstop";
import { TRUSTED_ORIGINS } from "@/lib/trusted-origins";
import { generateHandle } from "@/lib/utils/wallet-handle";
import { ONBOARDING_WORKFLOW_FIXTURES } from "@/scripts/seed/fixtures/onboarding-workflows";
import { wrapWithSessionTokenHash } from "./auth-session-token-hash";
import { db } from "./db";
import {
  accounts,
  deviceCode,
  integrations,
  invitationRelations,
  invitation as invitationTable,
  memberRelations,
  member as memberTable,
  organizationRelations,
  organizationSubscriptions,
  organization as organizationTable,
  sessions,
  twoFactor as twoFactorTable,
  users,
  verifications,
  walletAddress,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflows,
} from "./db/schema";

// SIWE wallet emails are always `0x<40-hex>@wallet.keeperhub.com`.
const WALLET_LOCAL_PART_RE = /^0x[0-9a-f]{40}$/i;

// Define custom access control for organization resources
const statement = {
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["read", "update", "delete"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "cancel"],
} as const;

const ac = createAccessControl(statement);

// Define role permissions aligned with requirements
const memberRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["read"],
  wallet: ["read"], // Can use wallet, not manage
  organization: ["read"],
  member: ["read"],
});

const adminRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"], // Can manage wallets
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

const ownerRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

// Construct schema object for drizzle adapter
const schema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  twoFactor: twoFactorTable,
  walletAddress,
  deviceCode,
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionsRelations,
  organization: organizationTable,
  member: memberTable,
  invitation: invitationTable,
  organizationRelations,
  memberRelations,
  invitationRelations,
};

function getBaseURL() {
  if (process.env.BETTER_AUTH_URL) {
    return process.env.BETTER_AUTH_URL;
  }
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  return "http://localhost:3000";
}

// Turnstile is gated on the signup endpoint. The secret key is required
// wherever the plugin is enforced - fail fast at module load rather than
// serving an open signup endpoint. Skip conditions:
//   1. Vitest / CI unit-test runs (NODE_ENV=test or CI=true) - tests assert
//      config shape without needing a live Turnstile challenge. These win
//      over TURNSTILE_ENFORCE so unit runs never load the live plugin.
//   2. When admin test endpoints are wired up (INCLUDE_TEST_ENDPOINTS=true,
//      with the same runtime gate testEndpointsEnabled enforces) and the
//      environment has NOT opted in via TURNSTILE_ENFORCE. This is the
//      Playwright E2E + local-dev-with-admin-tests path: requests carry
//      X-Test-API-Key for rate-limit bypass, and the captcha plugin's
//      onRequest middleware can't honor that header, so skip the plugin
//      instead.
// TURNSTILE_ENFORCE=true opts a non-production environment (staging,
// pr-deploy) into loading the plugin so the real Turnstile flow can be
// exercised before prod. Note: with the plugin loaded, the X-Test-API-Key
// signup bypass no longer applies - that environment's site/secret keys must
// be ones the widget+server can pass (e.g. Cloudflare's always-pass test
// keys) for any UI-driven signup E2E to keep working. Headless load-test /
// e2e clients that cannot solve a challenge present the LOAD_TEST_BYPASS_TOKEN
// instead (see the plugin wrapper below).
const SIGNUP_CAPTCHA_ENDPOINT = "/sign-up/email";
const captchaSecretKey = process.env.TURNSTILE_SECRET_KEY;
const captchaForceEnabled = process.env.TURNSTILE_ENFORCE === "true";
// start custom keeperhub code //
/**
 * Deliberate opt-out of the captcha, for a deployment that cannot use
 * Cloudflare.
 *
 * Without this the only way to boot without TURNSTILE_SECRET_KEY is CI=true,
 * which also disables unrelated behaviour and misdescribes the environment. The
 * other workaround, Cloudflare's always-pass test key pair, is worse than it
 * looks: signup still calls challenges.cloudflare.com twice and the captcha
 * verifies nothing, so the deployment carries the dependency without the
 * protection.
 *
 * TURNSTILE_ENFORCE wins over this, so a deployment that has explicitly asked
 * for the captcha cannot lose it by also setting this.
 */
const captchaDisabled =
  !captchaForceEnabled && process.env.TURNSTILE_DISABLED === "true";
// end keeperhub code //
const captchaSkippedForTests =
  process.env.CI === "true" ||
  process.env.NODE_ENV === "test" ||
  (!captchaForceEnabled &&
    testEndpointsEnabled() &&
    process.env.NODE_ENV !== "production");

// Captcha is mandatory in production and in any environment that explicitly
// opts in via TURNSTILE_ENFORCE. The secret is only required where the plugin
// is actually loaded, so gate on !captchaSkippedForTests too: a production
// build run with CI=true / NODE_ENV=test (the ephemeral e2e job boots the
// prod image with CI=true) skips the plugin entirely, and must not crash at
// module load demanding a secret it will never use. next build also evaluates
// route modules during the "Collecting page data" phase with NODE_ENV=production
// but no runtime secrets injected, so skip the assertion during that phase to
// avoid crashing the build. The assertion still fires at server boot
// (phase-production-server) of any environment that actually enforces captcha.
// start custom keeperhub code //
// The two reasons the captcha plugin is left out: the test-mode skips above, or
// a deployment that explicitly opted out because it cannot use Cloudflare.
const captchaOmitted = captchaSkippedForTests || captchaDisabled;
// end keeperhub code //
const captchaRequired =
  !captchaOmitted &&
  (process.env.NODE_ENV === "production" || captchaForceEnabled) &&
  process.env.NEXT_PHASE !== "phase-production-build";
if (captchaRequired && !captchaSecretKey) {
  throw new Error(
    "TURNSTILE_SECRET_KEY is required in production (or when TURNSTILE_ENFORCE=true) - refusing to expose /sign-up/email without captcha verification"
  );
}
// start custom keeperhub code //
// Say it out loud once at boot. Turning the captcha off leaves /sign-up/email
// open to automated signups, and an operator who inherited this configuration
// should find out from the log rather than from the account table.
if (captchaDisabled && process.env.NEXT_PHASE !== "phase-production-build") {
  logWarn(
    "[Auth] TURNSTILE_DISABLED=true - signup captcha is off and /sign-up/email accepts automated requests"
  );
}
// end keeperhub code //

// Wrap the captcha plugin's onRequest so trusted load-test / e2e traffic can
// skip the Turnstile check on signup. A real challenge cannot be solved
// headlessly, so k6 / Playwright present the LOAD_TEST_BYPASS_TOKEN (via the
// x-load-test-mfa-bypass header) - the same token that already clears the MFA
// gate (proxy.ts). Production never provisions the token, so the bypass is
// inert there and normal users always hit the real Turnstile verification.
function buildTurnstilePlugin(secretKey: string): ReturnType<typeof captcha> {
  const turnstile = captcha({
    provider: "cloudflare-turnstile",
    secretKey,
    endpoints: [SIGNUP_CAPTCHA_ENDPOINT],
  });
  return {
    ...turnstile,
    onRequest: (request, ctx) => {
      if (
        request.url.includes(SIGNUP_CAPTCHA_ENDPOINT) &&
        hasValidLoadTestBypass(request)
      ) {
        return Promise.resolve(undefined);
      }
      return turnstile.onRequest(request, ctx);
    },
  };
}

// captchaOmitted covers the opt-out too, so a deployment that opted out but
// still has a secret key lying around in its config makes no Cloudflare request.
const captchaPlugins =
  !captchaOmitted && captchaSecretKey
    ? [buildTurnstilePlugin(captchaSecretKey)]
    : [];

// Build plugins array conditionally
const plugins = [
  // start custom keeperhub code //
  deviceAuthorization({
    expiresIn: "15m",
    interval: "5s",
  }),
  // TOTP only. Email-OTP-as-second-factor is intentionally left without a
  // sendOTP callback because email OTP is already our primary login factor;
  // using it as the "second" factor would collapse both factors onto the
  // same channel. The /two-factor/send-otp endpoint is therefore inert
  // (would fail at call time) but our UI never invokes it. Backup codes
  // provide the recovery path. Enrollment is handled by a custom
  // passwordless endpoint (see app/api/user/totp/setup) because the
  // plugin's /two-factor/enable requires a password and most of our users
  // sign in via OAuth or email OTP.
  twoFactor({
    issuer: "KeeperHub",
    // Mandatory-MFA mode: do not remember the device. The plugin's
    // default `trustDeviceMaxAge` is 30 days, which lets a user skip
    // the TOTP step on the same browser for that window. Setting it
    // to 0 forces a TOTP prompt on every login, matching the
    // proxy-level requires_mfa=true-on-every-session policy.
    trustDeviceMaxAge: 0,
    // The plugin exposes an inert email-OTP-as-second-factor path
    // (no sendOTP wired, see comment above). If we ever turn it on,
    // store the OTP encrypted rather than the plugin default of
    // plaintext. Same primitive that the emailOTP plugin uses for
    // its own OTPs (KEEP-625). Defense in depth; sets the right
    // default ahead of any future flip.
    otpOptions: {
      storeOTP: "encrypted",
    },
  }),
  // end keeperhub code //
  emailOTP({
    async sendVerificationOTP({ email, otp, type }) {
      console.log(`[Auth] Sending OTP to ${email} for ${type}`);
      const success = await sendVerificationOTP({
        email,
        otp,
        type,
      });
      if (!success) {
        const msg = `[Auth] Failed to send verification email to ${email} — OTP is stored in DB`;
        if (process.env.CI || process.env.NODE_ENV === "test") {
          logWarn(msg);
        } else {
          logSystemError(
            ErrorCategory.EXTERNAL_SERVICE,
            msg,
            new Error("verification email send failed")
          );
        }
      }
    },
    otpLength: 6,
    expiresIn: 300, // 5 minutes
    // OTP delivery for credential signups is driven from
    // databaseHooks.user.create.after, which fires only when a new
    // user row is actually written. The plugin's
    // sendVerificationOnSignUp hook would otherwise fire on Better
    // Auth's synthetic-success response (returned anti-enumeration
    // when the email already belongs to an account), which would
    // dispatch an OTP to that inbox even though no DB write
    // happened.
    sendVerificationOnSignUp: false,
    // KEEP-625: the better-auth emailOTP plugin defaults to storing
    // OTPs in plaintext in the verifications table. With "encrypted"
    // the value is symmetric-encrypted with BETTER_AUTH_SECRET via
    // the same symmetricEncrypt used elsewhere, so a DB-read alone
    // can't reveal a live 6-digit code — the attacker also needs
    // the server secret. "hashed" would be cryptographically
    // brute-forceable in seconds for a 6-digit space; "encrypted"
    // is the right primitive for short, low-entropy secrets.
    storeOTP: "encrypted",
  }),
  anonymous({
    async onLinkAccount(data) {
      // When an anonymous session links to a real account, move its content
      // into the linking user's organization. All three updates are one atomic
      // transaction: a partial re-parent (e.g. workflows moved but executions
      // not) would leave inconsistent ownership history.
      const fromUserId = data.anonymousUser.user.id;
      const toUserId = data.newUser.user.id;

      await db.transaction(async (tx) => {
        // Selects the user's personal org (the one minted at signup, which is
        // always the oldest owner membership). A user is unlikely to own
        // multiple orgs at link time, but if they do the content goes into
        // the oldest one as the best proxy for their primary workspace.
        const [targetMembership] = await tx
          .select({ organizationId: memberTable.organizationId })
          .from(memberTable)
          .where(
            and(eq(memberTable.userId, toUserId), eq(memberTable.role, "owner"))
          )
          .orderBy(memberTable.createdAt)
          .limit(1);

        if (!targetMembership) {
          logSystemError(
            ErrorCategory.AUTH,
            "[Auth] Account link: no owner org found for target user; anonymous content not re-parented",
            new Error("targetMembership undefined"),
            { fromUserId, toUserId }
          );
          return;
        }

        await tx
          .update(workflows)
          .set({
            userId: toUserId,
            organizationId: targetMembership.organizationId,
            isAnonymous: false,
          })
          .where(eq(workflows.userId, fromUserId));

        await tx
          .update(integrations)
          .set({
            createdBy: toUserId,
            organizationId: targetMembership.organizationId,
          })
          .where(eq(integrations.createdBy, fromUserId));

        await tx
          .update(workflowExecutions)
          .set({ userId: toUserId })
          .where(eq(workflowExecutions.userId, fromUserId));
      });
    },
  }),
  // Sign-In With Ethereum. Lets any injected EOA wallet (MetaMask, Brave,
  // Rabby, ...) authenticate by signing a nonce. The signature is the
  // possession factor, so wallet sessions skip the TOTP step-up (see the
  // session.create.before hook and proxy.ts). `domain` must match the host
  // the client builds its SIWE message with (window.location.host).
  siwe({
    domain: new URL(getBaseURL()).host,
    emailDomainName: WALLET_EMAIL_DOMAIN,
    getNonce: () => Promise.resolve(generateSiweNonce()),
    verifyMessage: verifySiweSignature,
  }),
  ...captchaPlugins,
  organization({
    // Access control with custom roles
    ac,
    roles: {
      owner: ownerRole,
      admin: adminRole,
      member: memberRole,
    },

    // Wallet (SIWE) accounts authenticate by signature and never verify their
    // synthetic email, so better-auth's default email-verification gate on
    // invitation list/accept/reject/create (403 EMAIL_VERIFICATION_REQUIRED)
    // permanently hid received invites from them. Email/OAuth accounts are
    // already verified at signup, so this gate was a no-op for them; disabling
    // it only unblocks wallet users.
    requireEmailVerificationOnInvitation: false,

    // Email invitation handler using SendGrid
    async sendInvitationEmail(data) {
      const inviteLink = `${getBaseURL()}/accept-invite/${data.id}`;

      // Wallet (SIWE) invitees have a synthetic, non-deliverable email. Skip the
      // email and instead mint the sign-to-join challenge they sign on accept.
      if (isWalletEmail(data.email)) {
        const { mintInviteChallenge } = await import(
          "@/lib/org/wallet-invite-challenge"
        );
        await mintInviteChallenge(data.id);
        return;
      }

      console.log(`[Invitation] Sending to ${data.email}`, {
        inviter: data.inviter.user.name,
        organization: data.organization.name,
        role: data.role,
        link: inviteLink,
      });

      try {
        await sendInvitationEmail({
          inviteeEmail: data.email,
          inviterName: data.inviter.user.name || "A team member",
          organizationName: data.organization.name,
          role: data.role || "member",
          inviteLink,
        });
      } catch (error) {
        logSystemWarn(
          ErrorCategory.EXTERNAL_SERVICE,
          `[Invitation] Email delivery failed for ${data.email}, invitation is still valid`,
          error
        );
      }
    },

    // Invitation settings
    invitationExpiresIn: 7 * 24 * 60 * 60, // 7 days
    cancelPendingInvitationsOnReInvite: true,

    // Hooks for custom business logic
    organizationHooks: {
      async afterCreateOrganization(data) {
        const { organization: org } = data;
        await db
          .insert(organizationSubscriptions)
          .values({
            organizationId: org.id,
            plan: "free",
            status: "active",
          })
          .onConflictDoNothing({
            target: organizationSubscriptions.organizationId,
          });
      },

      async afterAddMember() {
        await Promise.resolve();
      },

      async afterCreateInvitation(data) {
        await recordAuditEvent({
          actor: {
            userId: data.inviter.id,
            organizationId: data.organization.id,
            authMethod: "session",
          },
          action: "member.invited",
          resourceType: "invitation",
          resourceId: data.invitation.id,
          after: { email: data.invitation.email, role: data.invitation.role },
        });
      },

      async afterAcceptInvitation(data) {
        await recordAuditEvent({
          actor: {
            userId: data.user.id,
            organizationId: data.organization.id,
            authMethod: "session",
          },
          action: "member.joined",
          resourceType: "member",
          resourceId: data.member.id,
          after: { role: data.member.role },
        });
      },

      // better-auth's updateMemberRole runs no custom route; the acting admin's
      // identity is not in the hook payload, so the actor is the org context
      // rather than a user. The affected member and the role transition are
      // still recorded.
      async afterUpdateMemberRole(data) {
        await recordAuditEvent({
          actor: {
            userId: null,
            organizationId: data.organization.id,
            authMethod: "session",
            actorLabel: "Organization admin",
          },
          action: "member.role_changed",
          resourceType: "member",
          resourceId: data.member.id,
          before: { role: data.previousRole },
          after: { role: data.member.role },
        });
      },

      // A-04: admin-initiated removal goes through better-auth's removeMember
      // (no custom route), so revoke the removed member's renewable MCP OAuth
      // refresh tokens for this org here. Access is already refused at use
      // time by the membership re-check; this clears the dormant 30-day
      // credential so it cannot linger. Mirrors the leave-route cascade.
      async afterRemoveMember(data) {
        // The removing admin's identity is not in the hook payload, so the
        // actor is the org context rather than a user; the removed member is
        // captured as the resource.
        await recordAuditEvent({
          actor: {
            userId: null,
            organizationId: data.organization.id,
            authMethod: "session",
            actorLabel: "Organization admin",
          },
          action: "member.removed",
          resourceType: "member",
          resourceId: data.user.id,
          before: { role: data.member.role },
        });

        // Best-effort: better-auth calls this after the member row is already
        // deleted and outside any transaction, and access is already refused
        // at use time by the membership re-check. A failure to clear the
        // dormant refresh tokens must not throw back and fail the removal
        // request itself - log and move on; the rows are inert.
        try {
          await revokeRefreshTokensForUserOrg(
            data.user.id,
            data.organization.id
          );
        } catch (err) {
          logSystemError(
            ErrorCategory.AUTH,
            "[Org] Failed to revoke MCP OAuth refresh tokens after member removal",
            err,
            {
              userId: data.user.id,
              organizationId: data.organization.id,
            }
          );
        }
      },
    },
  }),
];

async function subscribeToMailerLite(user: {
  name?: string | null;
  email?: string | null;
}): Promise<void> {
  const apiKey = process.env.MAILERLITE_API_KEY;
  if (!(apiKey && user.email)) {
    return;
  }

  await fetch("https://connect.mailerlite.com/api/subscribers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: user.email,
      groups: ["184355071771804948", "184358071395419781"],
      status: "active",
    }),
  })
    .then((res) => {
      if (!res.ok) {
        logUserError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[MailerLite] Subscribe failed",
          new Error(`${res.status} ${res.statusText}`),
          { status_code: String(res.status) }
        );
      }
    })
    .catch((err: unknown) => {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[MailerLite] Subscribe request error",
        err
      );
    });
}

async function notifyDiscordSignup(
  user: {
    name?: string | null;
    email?: string | null;
  },
  method: SignupMethod
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_SIGNUPS;
  if (!webhookUrl) {
    return;
  }

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "KeeperHub",
      embeds: [
        {
          title: "New signup",
          color: 5_763_719,
          fields: [
            { name: "Name", value: user.name ?? "N/A", inline: true },
            { name: "Email", value: user.email ?? "N/A", inline: true },
            { name: "Method", value: method, inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  })
    .then((res) => {
      if (!res.ok) {
        logUserError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[Discord] Webhook failed",
          new Error(`${res.status} ${res.statusText}`),
          { status_code: String(res.status) }
        );
      }
    })
    .catch((err: unknown) => {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Discord] Webhook request error",
        err
      );
    });
}

/**
 * Backstop for the signup-time fire-and-forget address book write. Runs on
 * every SIWE wallet sign-in: ensures the signing address is in the org's
 * address book regardless of whether the create.after write succeeded.
 * Idempotent (onConflictDoNothing) and non-fatal.
 */
async function backstopWalletAddressBook(
  userId: string,
  organizationId: string
): Promise<void> {
  try {
    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const email = userRow?.email;
    if (!(email && isWalletEmail(email))) {
      return;
    }

    const walletAddress = email.split("@")[0];
    await recordWalletInAddressBook({
      organizationId,
      address: walletAddress,
      label: "My Wallet",
      createdBy: userId,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[Auth] Backstop address book write failed on session create",
      error,
      { userId, organizationId }
    );
  }
}

/**
 * Backstop for the signup-time fire-and-forget wallet provisioning. Runs on
 * login (session.create.after): if the org still has no active wallet - because
 * the signup attempt failed or the pod was killed mid-flight - it re-attempts
 * provisioning in the background. Idempotent and non-fatal: skips anonymous
 * accounts and never throws into the auth flow.
 */
async function backstopProvisionWallet(
  userId: string,
  organizationId: string
): Promise<void> {
  try {
    // Lazy-loaded: these wallet modules pull in `server-only` (and Turnkey /
    // ethers). Importing them statically would drag all of that into every
    // consumer of lib/auth.ts at module-eval - including auth plugin
    // registration - so keep them out of the static graph and load on demand.
    const { organizationHasWallet } = await import("@/lib/web3/wallet-helpers");
    if (await organizationHasWallet(organizationId)) {
      return;
    }

    const [userRow] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const email = userRow?.email;
    if (!email || userRow?.name === "Anonymous" || email.startsWith("temp-")) {
      return;
    }

    const { provisionOrganizationWallet } = await import(
      "@/lib/turnkey/provision-org-wallet"
    );
    await provisionOrganizationWallet({ userId, organizationId, email });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Auth] Backstop wallet provisioning failed on session create",
      error,
      { userId, organizationId }
    );
  }
}

export const auth = betterAuth({
  baseURL: getBaseURL(),
  database: wrapWithSessionTokenHash(
    drizzleAdapter(db, {
      provider: "pg",
      schema,
    })
  ),
  logger: {
    level: "debug",
    disabled: false,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Reject signups from disposable / temporary email domains on both
          // paths -- email+password and OAuth callbacks both flow through
          // user.create. Throwing APIError surfaces the shared rejection
          // message to the client verbatim so the dialog can render a
          // specific UX instead of better-auth's generic "Failed to create
          // user" string.
          await Promise.resolve();
          const email = typeof user.email === "string" ? user.email : null;

          // Wallet (SIWE) signups arrive with `name` set to the raw 0x
          // address. Replace it with a friendly generated handle so the
          // address never surfaces in the org name or the audit trail. The
          // user confirms or edits it in the rename modal on first login.
          //
          // The SIWE plugin always mints emails as `0x<40-hex>@wallet.keeperhub.com`.
          // Block any other local-part so attackers cannot self-register with
          // the wallet domain via the email+password flow and get classified
          // as a wallet account everywhere (bypassing TOTP enrollment gates).
          if (email && isWalletEmail(email)) {
            const localPart = email.split("@")[0] ?? "";
            if (!WALLET_LOCAL_PART_RE.test(localPart)) {
              throw new APIError("BAD_REQUEST", {
                message: "This email domain is reserved.",
              });
            }
            return { data: { name: generateHandle() } };
          }

          if (email && isDisposableEmailDomain(email)) {
            logUserError(
              ErrorCategory.VALIDATION,
              `[Auth] Rejected signup for disposable email domain: ${email}`
            );
            throw new APIError("BAD_REQUEST", {
              message: DISPOSABLE_EMAIL_REJECTION_MESSAGE,
            });
          }
        },
        after: async (user) => {
          const isAnonymous =
            user.name === "Anonymous" || user.email?.startsWith("temp-");
          // Wallet (SIWE) accounts have a synthetic, non-deliverable email.
          // They still get an org (below) but no signup notifications and no
          // verification OTP -- there is no inbox to send to.
          const isWallet = isWalletEmail(user.email);

          // Every account - anonymous sessions included - gets an organization
          // so the org is the single owner of every workflow/integration and
          // there are no null-org rows. An anonymous account's org is merged
          // into the real org when the account is later linked (onLinkAccount).
          const baseName = user.name || user.email?.split("@")[0] || "User";
          const slug = `${baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${nanoid(6)}`;

          try {
            const orgId = randomUUID();
            const memberId = randomUUID();

            // Create organization directly in database (we don't have auth context here)
            const [org] = await db
              .insert(organizationTable)
              .values({
                id: orgId,
                name: `${baseName}'s Organization`,
                slug,
                createdAt: new Date(),
              })
              .returning();

            // Add user as owner member
            await db.insert(memberTable).values({
              id: memberId,
              organizationId: org.id,
              userId: user.id,
              role: "owner",
              createdAt: new Date(),
            });

            // New signups (not anonymous exploration) start with three example
            // workflows in their org so the app is not an empty canvas. They are
            // seeded disabled with placeholder fields for the user to fill in;
            // onboarding opens the first one on the canvas. Best-effort: a seed
            // failure must not fail signup.
            if (!isAnonymous) {
              try {
                const seededAt = Date.now();
                await db.insert(workflows).values(
                  ONBOARDING_WORKFLOW_FIXTURES.slice(0, 3).map(
                    (fixture, index) => ({
                      name: fixture.name,
                      description: fixture.description,
                      userId: user.id,
                      organizationId: org.id,
                      nodes: fixture.nodes,
                      edges: fixture.edges,
                      // Stagger timestamps so the first fixture is the oldest,
                      // and onboarding can open it deterministically.
                      createdAt: new Date(seededAt + index),
                      updatedAt: new Date(seededAt + index),
                    })
                  )
                );
              } catch (error) {
                logSystemError(
                  ErrorCategory.AUTH,
                  "[Auth] Failed to seed example workflows for new org",
                  error,
                  { userId: user.id }
                );
              }
            }

            // Auto-add the signing wallet to the address book so it is
            // immediately available for use in workflows.
            if (isWallet) {
              const walletAddress = user.email.split("@")[0];
              recordWalletInAddressBook({
                organizationId: org.id,
                address: walletAddress,
                label: "My Wallet",
                createdBy: user.id,
              });
            }
          } catch (error) {
            logSystemError(
              ErrorCategory.AUTH,
              "[Auth] Failed to mint org for new user",
              error,
              { userId: user.id }
            );
            // Re-throw: a user without an org cannot create workflows. Failing
            // signup cleanly here is better than creating a user who hits
            // errors on every subsequent action.
            throw error;
          }

          // Anonymous accounts get an org (above) but no signup
          // notifications or verification OTP - they have no real, verified
          // email (name "Anonymous" / temp- prefixed address).
          if (isAnonymous || isWallet) {
            return;
          }

          // The org's non-custodial wallet is provisioned client-side after
          // signup via the streamed GET /api/user/wallet/provision endpoint,
          // which awaits the Turnkey call and reports readiness to the UI.
          // session.create.after backstops any signup that never opens that
          // stream (API-only signup, or a tab closed mid-flight).

          // Notify external services for OAuth signups (already verified at creation).
          // `databaseHooks.user.create.after` only fires on actual user-row
          // inserts in current better-auth, so the freshness guard here is
          // belt-and-suspenders against any future adapter or hook reroute
          // that delivers an already-existing user into this path. Real
          // OAuth signups have createdAt = now and pass it trivially.
          if (
            user.emailVerified &&
            isFreshSignup(user) &&
            (await claimSignupNotification(user.id))
          ) {
            const method = await resolveSignupMethod(user.id, "OAuth");
            await notifyDiscordSignup(user, method);
            await subscribeToMailerLite(user);
          }

          // Credential signup: dispatch the verification OTP here
          // rather than via emailOTP.sendVerificationOnSignUp. This
          // hook only runs on a real user-row insert, so the OTP
          // can never reach the inbox of a pre-existing account
          // when an attacker POSTs /sign-up/email with that email.
          // OAuth users come pre-verified (provider attested), so
          // skip them. The `!user.emailVerified` guard separates
          // the two paths cleanly.
          if (!user.emailVerified && user.email) {
            try {
              await auth.api.sendVerificationOTP({
                body: { email: user.email, type: "email-verification" },
                headers: new Headers(),
              });
            } catch (error) {
              logSystemError(
                ErrorCategory.AUTH,
                "[Auth] Failed to dispatch signup verification OTP",
                error,
                // No email label - PII. userId is enough to investigate; the
                // email is derivable from it if needed.
                { userId: user.id }
              );
            }
          }
        },
      },
    },
    session: {
      create: {
        // Reject session creation when the user has been deactivated.
        // Better Auth's OAuth callback otherwise mints a fresh session on
        // every Google/GitHub signin attempt because it has no awareness
        // of users.deactivated_at. Returning false aborts the write before
        // the sessions row exists, so no cookie ever ships to the client.
        //
        // Mandatory step-up on every TOTP-enrolled login: every new
        // session for a user with two_factor_enabled = true starts with
        // requires_mfa = true. The per-action guards in
        // lib/middleware/owner-mfa-guard.ts then refuse sensitive actions
        // until the user completes /verify-mfa, which clears the flag.
        // Previously the flag was only set when login-risk detection
        // flagged a country anomaly; flipping it on unconditionally makes
        // step-up uniform across every fresh login rather than only the
        // risk-flagged subset. The geo risk signal is still recorded in
        // sessions.risk_flags_json when present, for detection / alerting.
        //
        // Forced enrollment for users without TOTP is intentionally not
        // wired here: a session for a non-TOTP user gets requires_mfa =
        // false because there is nothing to step up to. Mandating the
        // enrollment wizard is a separate follow-up.
        before: async (session) => {
          const userId =
            typeof session.userId === "string" ? session.userId : null;
          if (!userId) {
            return;
          }
          if (await isUserDeactivated(userId)) {
            // KEEP-612 detection signal. Better Auth has no per-request
            // audit hook, so emit here right before refusing the session
            // write. Tag is the alert key; user id lets triage pivot to
            // the row that's deactivated. No PII beyond the user id.
            // Wrapped in try/catch so a Sentry transport throw cannot
            // propagate out of the better-auth hook and surface as a
            // generic login error instead of the deactivated-user deny.
            logSecurityEvent(
              "deactivated_login_attempt",
              { surface: "session", userId },
              {
                tags: {
                  security: "deactivated_login_attempt",
                  surface: "session",
                },
                user: { id: userId },
              }
            );
            return false;
          }
          const risk = await assessLoginRisk(userId);
          const countryTrust = await assessCountryTrust(userId);
          // When the session is being created from a trusted country (or
          // for the user's first-ever attestation) record/refresh it in
          // user_trusted_countries. This is the only path that auto-adds a
          // country without going through /verify-ip; the unique
          // (user_id, country) constraint makes the upsert idempotent so a
          // repeat sign-in from a known country just bumps last_seen_at.
          if (countryTrust.country && countryTrust.trusted) {
            await upsertTrustedCountry(userId, countryTrust.country);
          }
          const [userRow] = await db
            .select({
              twoFactorEnabled: users.twoFactorEnabled,
              email: users.email,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          const twoFactorEnabled = userRow?.twoFactorEnabled === true;
          // Wallet (SIWE) sessions are authenticated by the signature itself,
          // so they are MFA-satisfied at creation. The proxy fully exempts
          // wallet users from the step-up gate; stamping mfaVerifiedAt keeps
          // the session row consistent with the OAuth-finalize path.
          const isWallet = isWalletEmail(userRow?.email);
          // Short-circuit wallet sessions BEFORE the twoFactorEnabled branch.
          // A wallet user who opts into TOTP (a per-action step-up factor, not a
          // login gate) has twoFactorEnabled = true; without this, they'd mint a
          // requiresMfa session with the short pre-step-up TTL below, but the
          // proxy never routes wallet users to /verify-mfa, so the session would
          // just expire -- repeated silent logout. For wallet users the
          // signature is the login factor, so the session is always satisfied.
          if (isWallet) {
            return {
              data: {
                requiresMfa: false,
                mfaVerifiedAt: new Date(),
                riskFlagsJson: risk.country ? serializeRiskFlags(risk) : null,
              },
            };
          }
          // Sessions that still need step-up get a short TTL so a stolen
          // cookie expires before a legitimate user finishes the
          // /verify-mfa flow.
          const PRE_STEPUP_TTL_MS = 10 * 60 * 1000;
          // Persist the risk blob whenever there is signal: a resolved
          // country, or an anomaly with no country (unknown_country — a
          // login we could no longer place). A null country with no anomaly
          // is inconclusive (local dev / self-hosted) and stored as null.
          const riskFlagsJson =
            risk.country || risk.anomaly ? serializeRiskFlags(risk) : null;
          // IP-verification does not write to the session row. The
          // atomic flow in strict-signin / oauth-mfa-finalize / the
          // /verify-ip endpoint resolves IP trust BEFORE any session
          // is minted: an untrusted IP produces a signed
          // `pending_ip_verify` cookie and no session, and a trusted
          // IP mints the session as-is.
          if (twoFactorEnabled) {
            return {
              data: {
                requiresMfa: true,
                expiresAt: new Date(Date.now() + PRE_STEPUP_TTL_MS),
                riskFlagsJson: risk.country ? serializeRiskFlags(risk) : null,
              },
            };
          }
          // Non-wallet users without TOTP: no step-up needed, no mfaVerifiedAt
          // stamp (wallet users already returned above).
          return {
            data: {
              requiresMfa: false,
              riskFlagsJson,
            },
          };
        },
        after: async (session) => {
          let orgId: string | null =
            (session.activeOrganizationId as string | null | undefined) ?? null;

          // Backfill the active org for sessions that don't carry one yet.
          if (!orgId) {
            try {
              const [member] = await db
                .select()
                .from(memberTable)
                .where(eq(memberTable.userId, session.userId))
                .limit(1);

              if (member) {
                orgId = member.organizationId;
                await db
                  .update(sessions)
                  .set({ activeOrganizationId: member.organizationId })
                  .where(eq(sessions.id, session.id));
              }
            } catch (error) {
              logSystemError(
                ErrorCategory.AUTH,
                "[Auth] Failed to set active org on session",
                error,
                { sessionId: session.id }
              );
            }
          }

          // Audit the sign-in. ip/userAgent are columns on the session row;
          // buildAuditMetadata isn't usable here (no Request in the hook), and
          // country is only resolved on the request path, so it stays null.
          const sessionRow = session as {
            ipAddress?: string | null;
            userAgent?: string | null;
          };
          await recordAuditEvent({
            actor: {
              userId: session.userId,
              organizationId: orgId,
              authMethod: "session",
            },
            action: "session.created",
            resourceType: "session",
            resourceId: session.id,
            metadata: {
              ip: sessionRow.ipAddress ?? null,
              country: null,
              userAgent: sessionRow.userAgent ?? null,
            },
          });

          // Backstop the signup-time wallet provisioning (fire-and-forget):
          // re-provision if the org somehow has no wallet yet. Intentionally
          // not awaited; backstopProvisionWallet handles its own errors.
          if (orgId) {
            backstopProvisionWallet(session.userId, orgId).catch(
              () => undefined
            );
            backstopWalletAddressBook(session.userId, orgId).catch(
              () => undefined
            );
          }
        },
      },
    },
    account: {
      create: {
        // Defence in depth for the OAuth re-link path: even if the session
        // hook above ever regresses, refuse to attach a fresh GitHub/Google
        // accounts row to a deactivated users row. Otherwise the attacker
        // shape is: OAuth callback misses the wiped accounts row, falls
        // back to email match, links a new accounts row, then proceeds to
        // session creation.
        before: async (account) => {
          const userId =
            typeof account.userId === "string" ? account.userId : null;
          if (userId && (await isUserDeactivated(userId))) {
            // Wrapped in try/catch so a Sentry transport throw cannot
            // propagate out of the OAuth re-link hook -- see session
            // surface above for the same pattern.
            logSecurityEvent(
              "deactivated_login_attempt",
              { surface: "account", userId },
              {
                tags: {
                  security: "deactivated_login_attempt",
                  surface: "account",
                },
                user: { id: userId },
              }
            );
            return false;
          }
        },
      },
    },
  },
  onAPIError: {
    onError: (error, _ctx) => {
      // KEEP-612: emit the sessions-backstop detection signal if this error
      // is the migration-0090 KH001 reject (a deactivated-user session insert
      // that bypassed the session.create.before gate). reportSessionBackstop
      // walks the wrapped-error cause chain + message fallback and is
      // unit-tested independently of the Better Auth config.
      reportSessionBackstop(error);
      const errName = error instanceof Error ? error.name : "unknown";
      const errMessage = error instanceof Error ? error.message : String(error);
      logWarn(`[Better Auth API Error] ${errName}: ${errMessage}`, {
        error_name: errName,
      });
    },
  },
  // Declare the custom session columns we added in migration 0089
  // (`requires_mfa`, `mfa_verified_at`, `risk_flags_json`). Without
  // these declarations Better Auth filters them out of any insert/
  // update payload before reaching the Drizzle adapter, so the
  // session.create.before hook's `data: { requiresMfa: true }` is
  // silently dropped and every TOTP-enrolled user sails past the
  // step-up gate. This is the field-declaration backbone for the
  // mandatory-step-up policy in proxy.ts.
  // Surface `display_name_confirmed` on the session user so the client can
  // gate the wallet rename modal. `input: false` keeps it server-controlled
  // (flipped via /api/user/display-name), not settable through signup.
  user: {
    additionalFields: {
      displayNameConfirmed: {
        type: "boolean",
        defaultValue: false,
        required: false,
        input: false,
      },
      onboardingCompleted: {
        type: "boolean",
        defaultValue: false,
        required: false,
        input: false,
      },
    },
  },
  session: {
    additionalFields: {
      requiresMfa: { type: "boolean", defaultValue: false },
      mfaVerifiedAt: { type: "date", required: false },
      riskFlagsJson: { type: "string", required: false },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  emailVerification: {
    afterEmailVerification: async (user) => {
      // This fires on every verifyEmail, not only the first, so freshness
      // alone let a user who re-verified inside the window announce themselves
      // once per attempt. The claim is what makes it once per account; the
      // freshness check stays as the cheaper first guard.
      if (!isFreshSignup(user)) {
        return;
      }
      if (!(await claimSignupNotification(user.id))) {
        return;
      }
      const method = await resolveSignupMethod(user.id, "Email");
      await notifyDiscordSignup(user, method);
      await subscribeToMailerLite(user);
    },
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
      enabled: !!process.env.GITHUB_CLIENT_ID,
      // Force the provider to re-prompt at every sign-in rather than
      // silently reusing an existing IdP session. Combined with the
      // session.create.before hook setting requires_mfa=true on every
      // TOTP-enrolled session, this gives the closest practical match
      // to "MFA on every login" for the OAuth path. The IdP itself
      // still owns the second-factor step on its side.
      prompt: "login",
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      enabled: !!process.env.GOOGLE_CLIENT_ID,
      prompt: "login",
    },
  },
  rateLimit: {
    enabled: !(process.env.CI || process.env.NODE_ENV === "test"),
    customRules: {
      // Per-IP signup gate (5/hour). Declared before "/*" so first-match
      // wins on /sign-up/email. The bypass is still honored via the
      // explicit call below so Playwright E2E keeps working with the
      // X-Test-API-Key header. In-memory storage means the effective
      // limit is 5 * pod_count; acceptable as defense-in-depth behind
      // Turnstile until a shared store is wired up.
      "/sign-up/email": (req) =>
        rateLimitBypassRule(req, { window: 3600, max: 5 }),
      // Per-IP anonymous sign-in gate (5/hour). Without it the endpoint falls
      // through to the loose "/*" default, leaving unbounded anon account/org
      // creation. Same in-memory caveat as signup (effective limit is
      // 5 * pod_count) and the same E2E bypass.
      "/sign-in/anonymous": (req) =>
        rateLimitBypassRule(req, { window: 3600, max: 5 }),
      // Per-IP SIWE gates. Nonce issuance is cheap but unauthenticated;
      // verify is the account/session-minting step. Bound both so a single
      // IP can't farm wallet accounts or brute nonces. Same in-memory caveat
      // (effective limit is max * pod_count) and the same E2E bypass.
      "/siwe/nonce": (req) =>
        rateLimitBypassRule(req, { window: 3600, max: 20 }),
      "/siwe/verify": (req) =>
        rateLimitBypassRule(req, { window: 3600, max: 10 }),
      // Rate-limit bypass is gated by the same predicate as admin test
      // routes (build-time + runtime). See lib/admin-auth.ts for the gate
      // and KEEP-237 for context.
      "/*": rateLimitBypassRule,
    },
  },
  advanced: {
    // Use secure cookies in production (HTTPS only)
    useSecureCookies: process.env.NODE_ENV === "production",
    // start custom keeperhub code //
    // Resolve the client IP from CF-Connecting-IP, not better-auth's default
    // X-Forwarded-For. Cloudflare appends the real client IP to any client-supplied
    // XFF rather than stripping it, so a caller can prepend whatever it likes.
    // CF-Connecting-IP is set at Cloudflare's edge and cannot be forged. All
    // KeeperHub envs sit behind Cloudflare with origin-pull, so it is always present.
    //
    // The list is the default rather than the only option, because a deployment
    // KeeperHub does not run has no Cloudflare and so resolves no address at all:
    // every rate limit collapses onto one shared bucket and the session row records
    // an empty string. Such a deployment names its own header via CLIENT_IP_HEADERS.
    // See lib/security/client-ip.ts.
    //
    // better-auth refuses a header carrying more than one comma-separated hop unless
    // trustedProxies names the hops, so a caller cannot prepend a spoofed address to
    // whatever header is configured. Passing the option only when the operator set it
    // keeps the single-hop rule in force everywhere else, including here.
    ipAddress: {
      ipAddressHeaders: [...CLIENT_IP_HEADERS],
      ...(CLIENT_IP_TRUSTED_PROXIES.length > 0
        ? { trustedProxies: [...CLIENT_IP_TRUSTED_PROXIES] }
        : {}),
    },
    // end keeperhub code //
  },
  trustedOrigins: [...TRUSTED_ORIGINS],
  plugins,
});
