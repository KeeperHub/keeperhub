/**
 * Email utilities for KeeperHub
 * Uses SendGrid API for transactional emails
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANS } from "@/lib/billing/plans";
import {
  ErrorCategory,
  logSystemError,
  logUserError,
  logWarn,
} from "@/lib/logging";
import { SUPPORT_EMAIL } from "@/lib/social-links";

const isTestEnv = !!process.env.CI || process.env.NODE_ENV === "test";

// start custom keeperhub code //
/**
 * Where the mail send is posted.
 *
 * Transactional mail carries signup OTPs, invites, password resets and MFA
 * step-up codes, so a deployment that cannot reach SendGrid cannot complete a
 * signup. Overriding this lets an operator point at their own relay - anything
 * that accepts SendGrid's v3 mail/send request shape - instead of patching the
 * source. Unset keeps the value this constant has always had.
 */
const SENDGRID_API_URL =
  process.env.SENDGRID_API_URL || "https://api.sendgrid.com/v3/mail/send";

/**
 * Logo shown at the top of transactional email.
 *
 * The recipient's mail client fetches this when the message is opened, so the
 * host learns their IP address and roughly when they read it. The default sits
 * in KeeperHub's own public repository, which means a deployment KeeperHub does
 * not run still shows our logo and still reports its users to GitHub.
 *
 * Point it at your own asset, or set it empty to send no logo at all - the
 * templates omit the image entirely rather than rendering a broken one.
 */
const EMAIL_LOGO_URL =
  process.env.EMAIL_LOGO_URL ??
  "https://raw.githubusercontent.com/KeeperHub/keeperhub/staging/public/keeperhub_logo_email.png";
// end keeperhub code //

// Cap the outbound SendGrid call so a stalled connection surfaces as a
// failed send (returns false) instead of hanging the request that's
// awaiting it -- otherwise a caller like the verify-IP OTP step spins
// on "Sending..." indefinitely.
const SENDGRID_TIMEOUT_MS = 10_000;

type EmailAttachment = {
  content: string;
  filename: string;
  type: string;
  disposition: "inline" | "attachment";
  content_id?: string;
};

type SendEmailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
};

/**
 * Normalize email address by removing + suffix
 * e.g., "jacob+test@example.com" -> "jacob@example.com"
 */
function normalizeEmail(email: string): string {
  const [localPart, domain] = email.split("@");
  if (!domain) {
    return email;
  }
  const normalizedLocal = localPart.split("+")[0];
  return `${normalizedLocal}@${domain}`;
}

/** Escape user-controlled strings before interpolating into email HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Send an email using SendGrid
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromAddress = process.env.FROM_ADDRESS || "noreply@keeperhub.com";
  const toAddress = normalizeEmail(options.to);

  if (!apiKey) {
    if (isTestEnv) {
      logWarn("[Email] SENDGRID_API_KEY not configured — skipping email send");
    } else {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Email] SENDGRID_API_KEY not configured",
        new Error("SENDGRID_API_KEY environment variable is not configured"),
        {
          component: "email-service",
          service: "sendgrid",
        }
      );
    }
    return false;
  }

  const emailData = {
    personalizations: [
      {
        to: [{ email: toAddress }],
        subject: options.subject,
      },
    ],
    from: { email: fromAddress, name: "KeeperHub" },
    content: [
      {
        type: "text/plain",
        value: options.text,
      },
      ...(options.html
        ? [
            {
              type: "text/html",
              value: options.html,
            },
          ]
        : []),
    ],
    ...(options.attachments?.length
      ? { attachments: options.attachments }
      : {}),
  };

  try {
    const response = await fetch(SENDGRID_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailData),
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Email] SendGrid error",
        new Error(errorText),
        {
          service: "sendgrid",
        }
      );
      return false;
    }

    return true;
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Email] Failed to send",
      error,
      {
        service: "sendgrid",
      }
    );
    return false;
  }
}

type InvitationEmailData = {
  inviteeEmail: string;
  inviterName: string;
  organizationName: string;
  role: string;
  inviteLink: string;
};

type VerificationOTPData = {
  email: string;
  otp: string;
  type:
    | "sign-in"
    | "email-verification"
    | "forget-password"
    | "change-email"
    | "confirm-action";
};

/**
 * Send email verification OTP code
 */
export async function sendVerificationOTP(
  data: VerificationOTPData
): Promise<boolean> {
  const { email, otp, type } = data;

  const logoUrl = EMAIL_LOGO_URL;

  const subjectMap = {
    "sign-in": "Your KeeperHub sign-in code",
    "email-verification": "Verify your email address - KeeperHub",
    "forget-password": "Reset your KeeperHub password",
    "change-email": "Confirm your new email - KeeperHub",
    "confirm-action": "Confirm a sensitive action - KeeperHub",
  };

  const actionTextMap = {
    "sign-in": "sign in",
    "email-verification": "verify your email address",
    "forget-password": "reset your password",
    "change-email": "confirm your new email address",
    "confirm-action": "confirm the action you just requested",
  };

  const actionPromptMap = {
    "sign-in": "Enter this code to sign in:",
    "email-verification": "Enter this code to verify your email address:",
    "forget-password": "Enter this code to reset your password:",
    "change-email": "Enter this code to confirm your new email:",
    "confirm-action": "Enter this code in the app to confirm the action:",
  };

  const subject = subjectMap[type];
  const actionText = actionTextMap[type];
  const actionPrompt = actionPromptMap[type];

  const text = `
Hi there,

Your verification code is: ${otp}

Enter this code to ${actionText}.

This code will expire in 5 minutes.

If you didn't request this code, you can safely ignore this email.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">Your Verification Code</h2>

    <p>${actionPrompt}</p>

    <div style="text-align: center; margin: 30px 0;">
      <div style="display: inline-block; background: #f5f5f5; padding: 20px 40px; border-radius: 8px; font-size: 32px; font-weight: bold; letter-spacing: 8px; font-family: monospace; color: #1a1a2e;">${otp}</div>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      This code will expire in 5 minutes. If you didn't request this code, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
  });

  if (success) {
    console.log(`[Email] OTP sent to ${email} for ${type}`);
  } else if (isTestEnv) {
    logWarn(`[Email] Failed to send OTP to ${email} — OTP is stored in DB`);
  } else {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send OTP to ${email}`,
      new Error("Failed to send verification OTP"),
      {
        service: "sendgrid",
        email_type: type,
      }
    );
  }

  return success;
}

type OAuthPasswordResetData = {
  email: string;
  providerName: string;
};

/**
 * Send email to OAuth users who try to reset password
 * Informs them to sign in using their OAuth provider instead
 */
export async function sendOAuthPasswordResetEmail(
  data: OAuthPasswordResetData
): Promise<boolean> {
  const { email, providerName } = data;

  const logoUrl = EMAIL_LOGO_URL;

  const subject = "Password Reset Request - KeeperHub";

  const text = `
Hi there,

We received a password reset request for your KeeperHub account.

Your account is linked to ${providerName} for sign-in. You don't have a password set with KeeperHub - your authentication is managed by ${providerName}.

To sign in, please use the "Continue with ${providerName}" option on our sign-in page.

If you didn't request this, you can safely ignore this email.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">Password Reset Request</h2>

    <p>We received a password reset request for your KeeperHub account.</p>

    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0; color: #0369a1;">
        <strong>Your account uses ${providerName} for sign-in.</strong><br>
        You don't have a password set with KeeperHub - your authentication is managed by ${providerName}.
      </p>
    </div>

    <p>To sign in, please use the <strong>"Continue with ${providerName}"</strong> option on our sign-in page.</p>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
  });

  if (success) {
    console.log(`[Email] OAuth password reset info sent to ${email}`);
  } else {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send OAuth info to ${email}`,
      new Error("Failed to send OAuth password reset email"),
      {
        service: "sendgrid",
        provider: providerName,
      }
    );
  }

  return success;
}

export async function sendInvitationEmail(
  data: InvitationEmailData
): Promise<boolean> {
  const { inviteeEmail, inviterName, organizationName, role, inviteLink } =
    data;

  const logoUrl = EMAIL_LOGO_URL;

  const subject = `You've been invited to join ${organizationName} on KeeperHub`;

  const text = `
Hi there,

${inviterName} has invited you to join ${organizationName} organization as a ${role} on KeeperHub.

Click the link below to accept the invitation and create your account:

${inviteLink}

This invitation will expire in 7 days.

If you didn't expect this invitation, you can safely ignore this email.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">You're Invited!</h2>

    <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> organization as a <strong>${role}</strong> on KeeperHub.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${inviteLink}" style="display: inline-block; background: #3b82f6; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Accept Invitation</a>
    </div>

    <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
    <p style="color: #3b82f6; font-size: 14px; word-break: break-all;">${inviteLink}</p>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: inviteeEmail,
    subject,
    text,
    html,
  });

  if (success) {
    console.log(`[Email] Invitation sent to ${inviteeEmail}`);
  } else if (isTestEnv) {
    logWarn(
      `[Email] Failed to send invitation to ${inviteeEmail} — invitation is stored in DB`
    );
  } else {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send invitation to ${inviteeEmail}`,
      new Error("Failed to send invitation email"),
      {
        service: "sendgrid",
      }
    );
  }

  return success;
}

type NewDeviceData = {
  email: string;
  ip: string | null;
  country: string | null;
  device: string;
  when: Date;
};

/**
 * Notify the account owner that a device they have not signed in from
 * before just authenticated. Fired once per (user, device) per week by
 * the sign-in device check; the account's first-ever device is not
 * emailed (that is the signup device). The full source IP is included so
 * the recipient can recognise the network.
 */
export async function sendNewDeviceEmail(
  data: NewDeviceData
): Promise<boolean> {
  const { email, ip, country, device, when } = data;

  const logoUrl = EMAIL_LOGO_URL;

  const subject = "New device signed in to your KeeperHub account";

  const whenFormatted = when.toUTCString();
  const countryLabel = country ?? "Unknown";
  const ipLabel = ip ?? "Unknown";

  const text = `
Hi,

A device we have not seen on your KeeperHub account before just signed in. If this was you, no action is needed. If this was not you, change your password and remove the device from your active sessions immediately.

Device: ${device}
Country: ${countryLabel}
IP: ${ipLabel}
When: ${whenFormatted}

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">New device signed in</h2>

    <p>A device we have not seen on your KeeperHub account before just signed in.</p>

    <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0; font-family: monospace; font-size: 14px;">
      <div><strong>Device:</strong> ${device}</div>
      <div><strong>Country:</strong> ${countryLabel}</div>
      <div><strong>IP:</strong> ${ipLabel}</div>
      <div><strong>When:</strong> ${whenFormatted}</div>
    </div>

    <p>If this was you, no action is needed.</p>

    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0; color: #991b1b;">
        <strong>If this was not you</strong>, change your password and remove the device from your active sessions immediately.
      </p>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      You're receiving this because a new device signed in to your account. To stop these alerts, sign in only from devices you recognise.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
  });

  if (!(success || isTestEnv)) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send new-device notification to ${email}`,
      new Error("Failed to send new-device notification"),
      {
        service: "sendgrid",
      }
    );
  }

  return success;
}

type ExecutionDigestEmailData = {
  to: string;
  orgName: string;
  organizationId: string;
  cadence: "daily" | "weekly" | "monthly";
  // Window the digest summarizes, [since, until).
  since: Date;
  until: Date;
  appUrl: string;
  stats: {
    total: number;
    success: number;
    error: number;
    // Runs refused before they started. Rendered in its own neutral section:
    // they never ran, so they are not failures and carry no rate.
    skipped: number;
    distinctWorkflows: number;
    transactionCount: number;
    gasUsedWei: string;
    // Present only when gas sponsorship is enabled; renders a sponsored card.
    sponsoredTransactionCount?: number;
  };
  topFailing: {
    workflowId: string;
    name: string;
    failures: number;
    lastError: string | null;
  }[];
  mostExecuted: {
    workflowId: string;
    name: string;
    runs: number;
  }[];
  topSkipped: {
    workflowId: string;
    name: string;
    skipped: number;
    lastReason: string | null;
  }[];
};

const DIGEST_PERIOD_LABEL: Record<"daily" | "weekly" | "monthly", string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

const DIGEST_SUMMARY_LABEL: Record<"daily" | "weekly" | "monthly", string> = {
  daily: "Daily summary",
  weekly: "Weekly summary",
  monthly: "Monthly summary",
};

/** Format a date as "DD/MM/YY HH:MM UTC" for the digest period line. */
function formatUtcStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = pad(date.getUTCDate());
  const month = pad(date.getUTCMonth() + 1);
  const year = pad(date.getUTCFullYear() % 100);
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  return `${day}/${month}/${year} ${hours}:${minutes} UTC`;
}

const DIGEST_SOCIAL_LINKS: { name: string; url: string; icon: string }[] = [
  {
    name: "LinkedIn",
    url: "https://www.linkedin.com/company/keeperhub/",
    icon: "linkedin",
  },
  { name: "X", url: "https://x.com/KeeperHubApp", icon: "x" },
  { name: "Discord", url: "https://discord.gg/keeperhub", icon: "discord" },
  {
    name: "YouTube",
    url: "https://www.youtube.com/@KeeperHub",
    icon: "youtube",
  },
  { name: "Telegram", url: "https://t.me/+S18ut1NJA5Q1NzBk", icon: "telegram" },
];

// Icons ship as inline (CID) attachments rather than hosted images so they
// render in every client without depending on an external URL. Read once and
// cached; missing files just drop that icon.
let digestSocialAttachmentsCache: EmailAttachment[] | null = null;

function getDigestSocialAttachments(): EmailAttachment[] {
  if (digestSocialAttachmentsCache) {
    return digestSocialAttachmentsCache;
  }
  const dir = join(process.cwd(), "public", "email", "social");
  const attachments: EmailAttachment[] = [];
  for (const { icon } of DIGEST_SOCIAL_LINKS) {
    try {
      const content = readFileSync(join(dir, `${icon}.png`)).toString("base64");
      attachments.push({
        content,
        filename: `${icon}.png`,
        type: "image/png",
        disposition: "inline",
        content_id: icon,
      });
    } catch {
      // Icon asset missing; skip it rather than fail the whole send.
    }
  }
  digestSocialAttachmentsCache = attachments;
  return attachments;
}

/** Format a summed wei amount as an ETH-equivalent string for display. */
function formatWeiToEth(weiStr: string): string {
  let wei: bigint;
  try {
    wei = BigInt(weiStr || "0");
  } catch {
    return "0";
  }
  if (wei === BigInt(0)) {
    return "0";
  }
  const eth = Number(wei) / 1e18;
  return eth < 0.0001 ? "<0.0001" : eth.toFixed(4);
}

/**
 * Send a scheduled (daily/weekly) workflow execution digest to a
 * subscribed org member.
 */
export async function sendWorkflowExecutionDigestEmail(
  data: ExecutionDigestEmailData
): Promise<boolean> {
  const {
    to,
    orgName,
    organizationId,
    cadence,
    since,
    until,
    appUrl,
    stats,
    topFailing,
    mostExecuted,
    topSkipped,
  } = data;
  const period = DIGEST_PERIOD_LABEL[cadence];
  const summaryLabel = DIGEST_SUMMARY_LABEL[cadence];
  const periodRange = `${formatUtcStamp(since)} to ${formatUtcStamp(until)}`;
  // Rate the run against completed runs only (success + error); pending,
  // running and cancelled runs are excluded so an org with many in-flight runs
  // is not reported as low success rate.
  const completed = stats.success + stats.error;
  const successRate =
    completed > 0 ? Math.round((stats.success / completed) * 100) : 0;
  const failRate =
    completed > 0 ? Math.round((stats.error / completed) * 100) : 0;
  const gasEth = formatWeiToEth(stats.gasUsedWei);
  const subject = `${orgName} workflow digest: ${stats.total} run${
    stats.total === 1 ? "" : "s"
  }, ${stats.error} failed (last ${period})`;

  const logoUrl = EMAIL_LOGO_URL;

  const workflowUrl = (id: string): string =>
    `${appUrl}/workflows/${encodeURIComponent(id)}`;

  // Deep-links into the org's Notifications settings so a recipient can adjust
  // or turn off this digest. Carries the org id so the app opens the right org.
  const manageUrl = `${appUrl}/workflows?digestSettings=${encodeURIComponent(
    organizationId
  )}`;

  const failingText = topFailing.length
    ? topFailing
        .map(
          (w) =>
            `- ${w.name}: ${w.failures} failure${w.failures === 1 ? "" : "s"}${
              w.lastError ? ` (last: ${w.lastError})` : ""
            } (${workflowUrl(w.workflowId)})`
        )
        .join("\n")
    : "No failing workflows.";

  const mostExecutedText = mostExecuted.length
    ? mostExecuted
        .map(
          (w) => `- ${w.name}: ${w.runs} runs (${workflowUrl(w.workflowId)})`
        )
        .join("\n")
    : "No executions.";

  const sponsoredText =
    stats.sponsoredTransactionCount === undefined
      ? ""
      : `\nSponsored transactions: ${stats.sponsoredTransactionCount}`;

  // Omitted entirely when nothing was refused, which is the normal case.
  const skippedText = stats.skipped
    ? `
Skipped: ${stats.skipped} (refused before starting, not failures)
${topSkipped
  .map(
    (w) =>
      `- ${w.name}: ${w.skipped} skipped${
        w.lastReason ? ` (${w.lastReason})` : ""
      } (${workflowUrl(w.workflowId)})`
  )
  .join("\n")}
`
    : "";

  const socialText = DIGEST_SOCIAL_LINKS.map((s) => `${s.name}: ${s.url}`).join(
    "\n"
  );

  const text = `
Organization: ${orgName}
${summaryLabel}
${periodRange}

Total runs: ${stats.total}
Workflows run: ${stats.distinctWorkflows}
On-chain transactions: ${stats.transactionCount}
Gas spent: ${gasEth} ETH${sponsoredText}

Succeeded: ${stats.success} (${successRate}%)
Most executed workflows:
${mostExecutedText}

Failed: ${stats.error} (${failRate}%)
Top failing workflows:
${failingText}
${skippedText}
View runs: ${appUrl}/analytics

You're receiving this digest for ${orgName} because you're an owner or admin of that organization.
Manage notifications: ${manageUrl}

---
KeeperHub - Blockchain Workflow Automation
${socialText}
`.trim();

  // Email-safe: table cells center reliably across clients where flexbox does
  // not. Each stat is a card cell; rows are full-width centered tables.
  const statCard = (
    value: string | number,
    label: string,
    color = "#1a1a2e"
  ): string =>
    `<td align="center" style="padding:6px;"><div style="background:#f5f5f5;border-radius:8px;padding:16px;"><div style="font-size:24px;font-weight:bold;color:${color};">${value}</div><div style="color:#999;font-size:12px;">${label}</div></div></td>`;

  const onchainCards = [
    statCard(stats.transactionCount, "On-chain txs"),
    statCard(gasEth, "Gas spent (ETH)"),
  ];
  if (stats.sponsoredTransactionCount !== undefined) {
    onchainCards.push(
      statCard(stats.sponsoredTransactionCount, "Sponsored txs")
    );
  }

  const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

  // Name links out to the workflow; the trailing arrow signals it's clickable.
  // title carries the full (untruncated) name as a hover tooltip.
  const nameLink = (
    id: string,
    name: string,
    fullName: string = name
  ): string =>
    `<a href="${workflowUrl(id)}" title="${escapeHtml(fullName)}" style="color:#1a1a2e;text-decoration:underline;">${escapeHtml(name)}</a><span style="color:#b5b5b5;">&nbsp;&#8599;</span>`;

  // One header row labels the otherwise-bare right column; rows themselves carry
  // no dividers so the link underlines aren't doubled up.
  const tableHeader = (rightLabel: string, rightColor = "#999"): string =>
    `<tr><th align="left" style="color:#999;font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;padding:0 0 6px;border-bottom:1px solid #eee;">Workflow</th><th align="right" style="color:${rightColor};font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;padding:0 0 6px;border-bottom:1px solid #eee;">${rightLabel}</th></tr>`;

  const failingRows = topFailing.length
    ? topFailing
        .map((w) => {
          const errorNote = w.lastError
            ? ` <span style="color:#999;" title="${escapeHtml(
                w.lastError
              )}">- ${escapeHtml(truncate(w.lastError, 42))}</span>`
            : "";
          return `<tr><td style="padding:6px 0;">${nameLink(
            w.workflowId,
            truncate(w.name, 26),
            w.name
          )}${errorNote}</td><td style="padding:6px 0;text-align:right;color:#c0392b;vertical-align:top;">${
            w.failures
          }</td></tr>`;
        })
        .join("")
    : `<tr><td style="padding:6px 0;color:#999;">No failing workflows.</td></tr>`;

  const mostExecutedRows = mostExecuted.length
    ? mostExecuted
        .map(
          (w) =>
            `<tr><td style="padding:6px 0;">${nameLink(
              w.workflowId,
              w.name
            )}</td><td style="padding:6px 0;text-align:right;">${
              w.runs
            }</td></tr>`
        )
        .join("")
    : `<tr><td style="padding:6px 0;color:#999;">No executions.</td></tr>`;

  // Neutral grey throughout: a skipped run is not an error, and colouring it
  // like one is the misread this section exists to prevent.
  const skippedRows = topSkipped
    .map((w) => {
      const reasonNote = w.lastReason
        ? ` <span style="color:#999;" title="${escapeHtml(
            w.lastReason
          )}">- ${escapeHtml(truncate(w.lastReason, 42))}</span>`
        : "";
      return `<tr><td style="padding:6px 0;">${nameLink(
        w.workflowId,
        truncate(w.name, 26),
        w.name
      )}${reasonNote}</td><td style="padding:6px 0;text-align:right;color:#666;vertical-align:top;">${
        w.skipped
      }</td></tr>`;
    })
    .join("");

  const skippedSection = stats.skipped
    ? `<div style="text-align:left; margin-top:28px;">
      <p style="margin:0 0 4px;"><span style="color:#666; font-weight:bold; font-size:17px;">Skipped: ${stats.skipped}</span> <span style="color:#999; font-size:13px;">- Runs refused before they started</span></p>
      <p style="margin:0 0 10px; color:#999; font-size:12px;">These runs never started, so they are not failures and do not count towards your success rate or your usage.</p>
      <table style="width:100%; border-collapse:collapse;">${tableHeader("Skipped")}${skippedRows}</table>
    </div>`
    : "";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>
  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
    <div style="margin:0 0 14px;">
      <div style="color:#999; font-size:11px; font-weight:600; letter-spacing:0.6px; text-transform:uppercase; margin-bottom:6px;">Organization</div>
      <span style="display:inline-block; background:#f5f5f5; border:1px solid #e5e5e5; border-radius:999px; padding:6px 14px; color:#1a1a2e; font-weight:600; font-size:14px;">${escapeHtml(orgName)}</span>
    </div>
    <h2 style="color: #1a1a2e; margin-top: 0;">${escapeHtml(orgName)} workflow digest</h2>
    <p style="color:#666; margin-bottom:10px;">${summaryLabel}</p>
    <p style="color:#444; font-size:13px; margin:0 0 4px;">${formatUtcStamp(since)} <span style="color:#aaa;">to</span> ${formatUtcStamp(until)}</p>
    <table role="presentation" width="100%" style="border-collapse:collapse; table-layout:fixed; margin:24px 0;">
      <tr>${statCard(stats.total, "Total runs")}${statCard(stats.distinctWorkflows, "Workflows run")}</tr>
    </table>
    <table role="presentation" width="100%" style="border-collapse:collapse; table-layout:fixed; margin:0 0 24px;">
      <tr>${onchainCards.join("")}</tr>
    </table>
    <div style="text-align:left;">
      <p style="margin:0 0 10px;"><span style="color:#27ae60; font-weight:bold; font-size:17px;">Succeeded: ${stats.success} (${successRate}%)</span> <span style="color:#999; font-size:13px;">- Most executed workflows</span></p>
      <table style="width:100%; border-collapse:collapse;">${tableHeader("Runs")}${mostExecutedRows}</table>
    </div>
    <div style="text-align:left; margin-top:28px;">
      <p style="margin:0 0 10px;"><span style="color:#c0392b; font-weight:bold; font-size:17px;">Failed: ${stats.error} (${failRate}%)</span> <span style="color:#999; font-size:13px;">- Top failing workflows</span></p>
      <table style="width:100%; border-collapse:collapse;">${tableHeader("Failures", "#c0392b")}${failingRows}</table>
    </div>
    ${skippedSection}
    <div style="margin:30px 0 0;">
      <a href="${appUrl}/analytics" style="display:inline-block; background:#1a1a2e; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none;">View runs</a>
    </div>
  </div>
  <div style="text-align: center; padding: 24px 20px; color: #999; font-size: 12px;">
    <table role="presentation" align="center" style="margin:0 auto 12px;"><tr>${DIGEST_SOCIAL_LINKS.map(
      (s) =>
        `<td style="padding:0 8px;"><a href="${s.url}" target="_blank" rel="noopener"><img src="cid:${s.icon}" alt="${s.name}" width="20" height="20" style="display:block;" /></a></td>`
    ).join("")}</tr></table>
    <p style="margin: 0 0 6px;">You're receiving this digest for <strong>${escapeHtml(orgName)}</strong> because you're an owner or admin of that organization.</p>
    <p style="margin: 0 0 12px;"><a href="${manageUrl}" style="color:#666; text-decoration:underline;">Manage notifications</a></p>
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  return await sendEmail({
    to,
    subject,
    text,
    html,
    attachments: getDigestSocialAttachments(),
  });
}

type ApiKeyChangeData = {
  email: string;
  action: "created" | "revoked";
  tokenName: string | null;
  keyPrefix: string;
  when: Date;
};

/**
 * Notify the account owner out-of-band whenever an API key is minted or
 * revoked. An API key is the longest-lived bypass credential a session can
 * mint, so the owner should learn about a create/revoke even if their session
 * was the one that did it -- a silent key issued from a stolen session is the
 * exact thing this surfaces.
 */
export async function sendApiKeyChangeEmail(
  data: ApiKeyChangeData
): Promise<boolean> {
  const { email, action, tokenName, keyPrefix, when } = data;

  const logoUrl = EMAIL_LOGO_URL;

  const created = action === "created";
  const subject = created
    ? "A new API key was created - KeeperHub"
    : "An API key was revoked - KeeperHub";
  const heading = created ? "New API key created" : "API key revoked";
  const lead = created
    ? "A new API key was just created on your KeeperHub account."
    : "An API key was just revoked from your KeeperHub account.";
  const nameLabel = tokenName ?? "Unnamed key";
  const whenFormatted = when.toUTCString();

  const text = `
Hi,

${lead}

Name: ${nameLabel}
Key: ${keyPrefix}...
When: ${whenFormatted}

If this was you, no action is needed. If this was not you, revoke your API keys and change your password immediately.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">${heading}</h2>

    <p>${lead}</p>

    <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0; font-family: monospace; font-size: 14px;">
      <div><strong>Name:</strong> ${nameLabel}</div>
      <div><strong>Key:</strong> ${keyPrefix}...</div>
      <div><strong>When:</strong> ${whenFormatted}</div>
    </div>

    <p>If this was you, no action is needed.</p>

    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0; color: #991b1b;">
        <strong>If this was not you</strong>, revoke your API keys and change your password immediately.
      </p>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      You're receiving this because API keys on your account were changed. These notifications cannot be turned off as they protect your account.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
  });

  if (!(success || isTestEnv)) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send API key ${action} notification to ${email}`,
      new Error("Failed to send API key change notification"),
      {
        service: "sendgrid",
        action,
      }
    );
  }

  return success;
}

type SecurityAlertData = {
  email: string;
  // Human-readable phrase completing "{actor} ___" (from describeAuditAction),
  // e.g. "exported a wallet private key".
  actionPhrase: string;
  actorLabel: string;
  when: Date;
  resourceType?: string | null;
};

/**
 * Notify an organization owner out-of-band when a high-risk action (wallet
 * private-key export, withdrawal, Safe role/allowance change, HMAC rotation,
 * org deactivation, ...) is recorded. The real-time signal so an owner learns
 * promptly rather than only on a later trail review. Carries the action phrase
 * and actor only -- never the diff, a secret, or a payload.
 */
export async function sendSecurityAlertEmail(
  data: SecurityAlertData
): Promise<boolean> {
  const { email, actionPhrase, actorLabel, when, resourceType } = data;
  const logoUrl = EMAIL_LOGO_URL;
  const whenFormatted = when.toUTCString();
  const summary = `${actorLabel} ${actionPhrase}`;
  const subject = "Security alert: a high-risk action on your organization";

  const text = `
Hi,

A high-risk security action was just performed on your KeeperHub organization.

What: ${summary}
${resourceType ? `Resource: ${resourceType}\n` : ""}When: ${whenFormatted}

If this was expected, no action is needed. If it was not, revoke the actor's access, rotate affected credentials, and contact support immediately.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">High-risk security action</h2>

    <p>A high-risk security action was just performed on your KeeperHub organization.</p>

    <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0; font-size: 14px;">
      <div><strong>What:</strong> ${summary}</div>
      ${resourceType ? `<div><strong>Resource:</strong> ${resourceType}</div>` : ""}
      <div><strong>When:</strong> ${whenFormatted}</div>
    </div>

    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0; color: #991b1b;">
        <strong>If this was not expected</strong>, revoke the actor's access, rotate affected credentials, and contact support immediately.
      </p>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      You're receiving this as an owner of the organization. These security notifications cannot be turned off.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({ to: email, subject, text, html });

  if (!(success || isTestEnv)) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send security alert to ${email}`,
      new Error("Failed to send security alert notification"),
      { service: "sendgrid" }
    );
  }

  return success;
}

type AccountDeactivatedData = {
  email: string;
  // The user's display name (the single `name` column). May be null/empty for
  // OAuth-only or anonymous accounts, in which case we fall back to a neutral
  // greeting.
  name?: string | null;
};

/**
 * Notify a user that their account was suspended for security review after
 * automated systems flagged activity. Intentionally vague about what was
 * detected -- we do not want to hand an attacker a description of our
 * detection. The social channels in the shared footer (Discord, Telegram,
 * etc.) are how a wrongly-suspended user can reach us.
 */
export async function sendAccountDeactivatedEmail(
  data: AccountDeactivatedData
): Promise<boolean> {
  const { email, name } = data;

  const logoUrl = EMAIL_LOGO_URL;

  const subject = "Your KeeperHub account access has been suspended";

  const trimmedName = name?.trim();
  const greetingText = trimmedName ? `Hi ${trimmedName},` : "Hi,";
  const greetingHtml = trimmedName ? `Hi ${escapeHtml(trimmedName)},` : "Hi,";

  // Shared social footer (same set the execution-digest email uses); contact
  // channels live here rather than in the body.
  const socialText = DIGEST_SOCIAL_LINKS.map((s) => `${s.name}: ${s.url}`).join(
    "\n"
  );

  const text = `
${greetingText}

Our automated security systems have temporarily suspended access to your KeeperHub account after detecting activity that requires additional review. Our team is already conducting a review. During this time, you will not be able to sign in or run workflows.

This review helps us maintain the security and integrity of the KeeperHub platform and protect our users. Your data remains safe, secure, and unchanged throughout this process. All workflows, configurations, and account data are preserved and will remain available once access is restored.

If you believe this action was taken in error or would like additional information, please contact our support team via the channels listed below (Discord or Telegram). We will review your case and assist you as quickly as possible.

Thank you for your understanding and cooperation.

Kind regards,
KeeperHub Team

---
KeeperHub - Blockchain Workflow Automation
${socialText}
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logoUrl ? `<img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />` : ""}
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">Your account access has been suspended</h2>

    <p>${greetingHtml}</p>

    <p>Our automated security systems have temporarily suspended access to your KeeperHub account after detecting activity that requires additional review. Our team is already conducting a review. During this time, you will not be able to sign in or run workflows.</p>

    <p>This review helps us maintain the security and integrity of the KeeperHub platform and protect our users. Your data remains safe, secure, and unchanged throughout this process. All workflows, configurations, and account data are preserved and will remain available once access is restored.</p>

    <div style="background: #f5f5f5; border-left: 4px solid #3b82f6; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
      <p style="margin: 0;">If you believe this action was taken in error or would like additional information, please contact our support team via the channels below (Discord or Telegram). We will review your case and assist you as quickly as possible.</p>
    </div>

    <p style="margin-bottom: 0;">Thank you for your understanding and cooperation.</p>
    <p style="margin-top: 8px;">Kind regards,<br>KeeperHub Team</p>
  </div>

  <div style="text-align: center; padding: 24px 20px; color: #999; font-size: 12px;">
    <table role="presentation" align="center" style="margin:0 auto 12px;"><tr>${DIGEST_SOCIAL_LINKS.map(
      (s) =>
        `<td style="padding:0 8px;"><a href="${s.url}" target="_blank" rel="noopener"><img src="cid:${s.icon}" alt="${s.name}" width="20" height="20" style="display:block;" /></a></td>`
    ).join("")}</tr></table>
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
    attachments: getDigestSocialAttachments(),
  });

  if (success) {
    console.log(`[Email] Account suspension notice sent to ${email}`);
  } else if (!isTestEnv) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send suspension notice to ${email}`,
      new Error("Failed to send account suspension email"),
      {
        service: "sendgrid",
      }
    );
  }

  return success;
}

/**
 * Pay-as-you-go settlement details, present only for orgs that can run past
 * their quota on it. Decimal USDC strings straight from the billing config, so
 * the figures quoted here are the figures shown in Billing.
 */
export type ExecutionQuotaPaygDetails = {
  priceUsdc: string;
  dailyCapUsdc: string;
  periodCapUsdc: string;
  // Settlement network, "Base" today.
  chainName: string;
  // Block explorer page for the exact token charges settle in, so the reader
  // can confirm which USDC contract is meant without being told to be careful.
  assetUrl: string;
};

type ExecutionQuotaEmailData = {
  email: string;
  orgName: string;
  planLabel: string;
  // 80 = approaching the limit, 100 = limit reached.
  threshold: number;
  used: number;
  limit: number;
  usagePercent: number;
  // When the monthly count resets to zero (start of the next UTC month).
  resetDate: Date;
  // Deep links into the org's own settings pages.
  plansUrl: string;
  billingUrl: string;
  // Set when the org can keep running past the limit by paying per execution.
  payg: ExecutionQuotaPaygDetails | null;
  // Dollars per 1,000 executions past the limit, or null when not billed.
  overageRatePerThousand: number | null;
};

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Match the Billing UI's USDC rendering so quoted figures agree with it. */
function formatUsdcAmount(decimal: string): string {
  return `$${Number(decimal).toLocaleString("en-US", {
    maximumFractionDigits: 6,
  })}`;
}

type TierRung = {
  planName: string;
  executions: number;
  monthlyPrice: number;
};

/**
 * The closing pitch and the action that goes with it. The action is part of the
 * pitch because it is not always the same: an org that has outgrown every
 * published tier is offered a conversation, not a pricing page.
 */
type UpgradePitch = {
  text: string;
  html: string;
  ctaLabel: string;
  ctaUrl: string;
};

/**
 * Every published tier, smallest to largest, Pro then Business. An org over its
 * quota moves up this ladder one rung at a time, which crosses from Pro into
 * Business at the top of Pro rather than jumping plans.
 */
const TIER_LADDER: TierRung[] = [
  ...PLANS.pro.tiers.map((tier) => ({
    planName: PLANS.pro.name,
    executions: tier.executions,
    monthlyPrice: tier.monthlyPrice,
  })),
  ...PLANS.business.tiers.map((tier) => ({
    planName: PLANS.business.name,
    executions: tier.executions,
    monthlyPrice: tier.monthlyPrice,
  })),
];

/** "2x" for a whole multiple, "2.5x" where the step is not a round one. */
function formatMultiple(ratio: number): string {
  return Number.isInteger(ratio) ? `${ratio}x` : `${ratio.toFixed(1)}x`;
}

/** "$2" and "$1.50", never "$1.5", which reads as a typo in a price. */
function formatDollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * How a link reads in the plain-text body. A mailto: with a subject query is
 * correct in an href and unreadable as text, so it degrades to the address.
 */
function plainLinkTarget(url: string): string {
  return url.startsWith("mailto:")
    ? url.slice("mailto:".length).split("?")[0]
    : url;
}

/**
 * The next tier up from an org's current included quota, and the point at which
 * paying for it beats paying overage.
 *
 * Overage is priced per execution and a tier step is a flat monthly amount, so
 * there is an exact crossover. Naming the tier, its price and that crossover is
 * more use than telling someone a bigger plan exists. Falls back to a plain
 * suggestion when the org's quota does not match a published tier (a custom
 * contract), and to an Enterprise pointer at the top of the ladder.
 */
function overageUpgradeComparison(
  currentLimit: number,
  overageRatePerThousand: number,
  plansUrl: string
): UpgradePitch {
  const next = TIER_LADDER.find((rung) => rung.executions > currentLimit);

  if (!next) {
    // Past the published tiers there is nothing to self-serve, and an org at
    // this volume is not helped by being pointed at a pricing page. Offer the
    // conversation instead.
    const top =
      "You are past our largest published tier, so the next step is a plan shaped around how you actually run: pricing, limits and support set to match. Tell us what you need and we will put numbers to it.";
    return {
      text: top,
      html: top,
      ctaLabel: "Talk to us",
      ctaUrl: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
        "Custom plan enquiry"
      )}`,
    };
  }

  const gain = `${next.planName} ${formatCount(
    next.executions
  )} gets you ${formatMultiple(next.executions / currentLimit)} the executions`;

  const current = TIER_LADDER.find((rung) => rung.executions === currentLimit);
  const perExecution = overageRatePerThousand / 1000;
  let rest = `${formatDollars(next.monthlyPrice)} a month.`;

  if (current && perExecution > 0) {
    // Rounded to the nearest hundred: a "roughly where it flips" figure, not a
    // quote.
    const breakEven =
      currentLimit +
      Math.round(
        (next.monthlyPrice - current.monthlyPrice) / perExecution / 100
      ) *
        100;
    rest = `${formatDollars(next.monthlyPrice)} a month. That is roughly what overage costs you at ${formatCount(
      breakEven
    )} executions.`;
  }

  return {
    text: `At this rate, ${gain}: ${rest}`,
    html: `At this rate, <strong style="color:#1a1a2e;">${gain}</strong>: ${rest}`,
    ctaLabel: "See plans",
    ctaUrl: plansUrl,
  };
}

/**
 * The concrete case for a plan over pay-as-you-go.
 *
 * A free org paying per execution hits the entry Pro price at a knowable
 * number of executions, and past that point it is spending Pro money for a
 * fraction of Pro's quota. Saying where that crossover falls is more use than
 * a general nudge to upgrade, so the arithmetic is done here rather than left
 * to the reader. Falls back to the generic line if the plan data cannot
 * support the comparison.
 */
function paygUpgradeComparison(
  payg: ExecutionQuotaPaygDetails,
  currentLimit: number,
  plansUrl: string
): UpgradePitch {
  const entryTier = PLANS.pro.tiers[0];
  const perExecution = Number(payg.priceUsdc);

  if (!entryTier || perExecution <= 0 || entryTier.executions <= currentLimit) {
    const fallback =
      "If this is your new normal, moving to a plan with a larger included quota costs less per execution than running over.";
    return {
      text: fallback,
      html: fallback,
      ctaLabel: "See plans",
      ctaUrl: plansUrl,
    };
  }

  // Rounded to the nearest hundred: this is a "roughly where it flips" figure,
  // not a quote.
  const breakEven =
    currentLimit +
    Math.round(entryTier.monthlyPrice / perExecution / 100) * 100;
  const headroom = Math.round(entryTier.executions / currentLimit);

  // The gain is the point of the paragraph, so it carries the emphasis in HTML
  // while the plain-text alternative stays free of markup.
  const gain = `${PLANS.pro.name} gets you ${headroom}x your ${formatCount(
    currentLimit
  )} free executions`;
  const rest = `${formatCount(entryTier.executions)} a month for ${formatDollars(
    entryTier.monthlyPrice
  )}. That is roughly what pay-as-you-go costs you at ${formatCount(
    breakEven
  )} executions.`;

  return {
    text: `At this rate, ${gain}: ${rest}`,
    html: `At this rate, <strong style="color:#1a1a2e;">${gain}</strong>: ${rest}`,
    ctaLabel: "See plans",
    ctaUrl: plansUrl,
  };
}

/** Format a date as "1 September 2026" for the quota reset line. */
function formatUtcDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Tell an organization owner they are approaching (80%) or have reached (100%)
 * their plan's monthly execution quota, and what they can do about it: keep
 * running on pay-as-you-go, or move to a plan with a bigger included quota.
 *
 * Sent at most once per organization per threshold per quota month. The
 * debounce lives in the execution_quota_notifications table, not here.
 */
export async function sendExecutionQuotaEmail(
  data: ExecutionQuotaEmailData
): Promise<boolean> {
  const {
    email,
    orgName,
    planLabel,
    threshold,
    used,
    limit,
    usagePercent,
    resetDate,
    plansUrl,
    billingUrl,
    payg,
    overageRatePerThousand,
  } = data;

  const logoUrl =
    "https://raw.githubusercontent.com/KeeperHub/keeperhub/staging/public/keeperhub_logo_email.png";

  const atLimit = threshold >= 100;
  // On an overage plan nothing is actually limited, so "limit reached" would
  // read as an outage the org needs to fix. Those get "included executions"
  // wording instead.
  const billsOverage = !payg && overageRatePerThousand !== null;

  let subject: string;
  let heading: string;
  if (!atLimit) {
    subject = `${orgName} has used ${usagePercent}% of its monthly executions - KeeperHub`;
    heading = "You're approaching your monthly execution limit";
  } else if (billsOverage) {
    subject = `${orgName} has used all its included monthly executions - KeeperHub`;
    heading = "You've used all your included executions";
  } else {
    subject = `${orgName} has reached its monthly execution limit - KeeperHub`;
    heading = "You've reached your monthly execution limit";
  }

  const usedLabel = formatCount(used);
  const limitLabel = formatCount(limit);
  const resetLabel = formatUtcDate(resetDate);

  // On Pay per execution the allowance is the free part of the plan, so it is
  // named as such rather than as "executions included in the Pay per execution
  // plan", which reads as a contradiction.
  const allowance = payg
    ? `${limitLabel} free executions`
    : `${limitLabel} executions`;
  const lead = atLimit
    ? `${orgName} has used all ${allowance} included in ${planLabel} this month. The quota resets on ${resetLabel}.`
    : `${orgName} has used ${usedLabel} of the ${allowance} included in ${planLabel} this month. The quota resets on ${resetLabel}.`;

  // What happens next depends on how the plan handles running past the limit:
  // pay-as-you-go charges per execution, overage plans bill the excess, and a
  // plan with neither stops until the quota resets.
  let continuityText: string;
  if (payg) {
    const priceLabel = formatUsdcAmount(payg.priceUsdc);
    // Deliberately not "nothing stops". Past the quota a run needs a funded
    // wallet and room under the caps, so an unqualified promise is wrong for
    // anyone whose wallet is empty. The two conditions follow immediately.
    continuityText = atLimit
      ? `Past your included executions, workflows run on pay-as-you-go at ${priceLabel} each, charged to your organization wallet.`
      : `Past your included executions, workflows carry on with pay-as-you-go at ${priceLabel} each, charged to your organization wallet.`;
  } else if (overageRatePerThousand === null) {
    continuityText = atLimit
      ? `Further executions are refused until the quota resets on ${resetLabel}. A plan with a larger included quota restores them straight away.`
      : "Once the included quota is used up, further executions are refused until it resets.";
  } else {
    continuityText = atLimit
      ? `Nothing has stopped, and there is nothing you need to do. Executions past your included quota are billed as overage at ${formatDollars(overageRatePerThousand)} per 1,000 on your next invoice.`
      : `Nothing stops when you reach it. Executions past your included quota are billed as overage at ${formatDollars(overageRatePerThousand)} per 1,000 on your next invoice.`;
  }

  // Both conditions gate a pay-as-you-go run. Naming only the wallet balance
  // leaves a capped org wondering why it stopped despite having funds. Labelled
  // with the words Billing uses on screen so the two line up.
  const runConditions = payg
    ? [
        {
          label: "Wallet balance",
          detail: `Executions are paid in USDC on ${payg.chainName} from your organization wallet. When it runs out, they stop.`,
        },
        {
          label: "Spend caps",
          detail: `You cap what we can charge: ${formatUsdcAmount(
            payg.dailyCapUsdc
          )} a day and ${formatUsdcAmount(
            payg.periodCapUsdc
          )} a month. Hit a cap and executions stop until the next day or month, even if the wallet still has funds.`,
        },
      ]
    : [];

  // The wallet address is deliberately not printed here. Users should copy a
  // deposit address from the app, never from an email, or we train them into
  // exactly the swap an address-substitution phish relies on.
  const topUpText = payg
    ? `Top up by sending USDC on ${payg.chainName} to the wallet address in Billing. No ETH needed, we cover gas.`
    : "";

  const genericUpgradeText =
    "If this is your new normal, a larger tier costs less per execution than running over.";
  let upgradePitch: UpgradePitch;
  if (payg) {
    upgradePitch = paygUpgradeComparison(payg, limit, plansUrl);
  } else if (overageRatePerThousand === null) {
    upgradePitch = {
      text: genericUpgradeText,
      html: genericUpgradeText,
      ctaLabel: "See plans",
      ctaUrl: plansUrl,
    };
  } else {
    upgradePitch = overageUpgradeComparison(
      limit,
      overageRatePerThousand,
      plansUrl
    );
  }

  // Each call to action sits directly under the paragraph that motivates it,
  // rather than stacking both at the foot of the mail.
  const ctaButton = (
    url: string,
    label: string,
    filled: boolean
  ): string => `<div style="text-align:center; margin:20px 0 28px;">
      <a href="${url}" style="display:inline-block; ${
        filled
          ? "background:#1a1a2e; color:#fff; border:1px solid #1a1a2e;"
          : "background:#ffffff; color:#1a1a2e; border:1px solid #d4d4d4;"
      } padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:600;">${label}</a>
    </div>`;

  const topUpHtmlBlock = payg
    ? `
    <p style="margin:24px 0 12px; font-weight:600; color:#1a1a2e;">Two things keep them running</p>
    <table role="presentation" width="100%" style="border-collapse:collapse; border:1px solid #e5e5e5; border-radius:8px;">
      ${runConditions
        .map(
          (row, i) =>
            `<tr><td style="padding:14px 16px; ${
              i > 0 ? "border-top:1px solid #eee;" : ""
            } font-size:14px; color:#444;"><strong style="color:#1a1a2e;">${escapeHtml(
              row.label
            )}</strong><br>${escapeHtml(row.detail)}</td></tr>`
        )
        .join("")}
    </table>

    <p style="margin:20px 0 0;">${escapeHtml(topUpText)}</p>
    <p style="margin:8px 0 0; color:#999; font-size:13px;">Only <a href="${payg.assetUrl}" style="color:#666;" target="_blank" rel="noopener">USDC on ${escapeHtml(payg.chainName)}</a> pays for executions. Anything else you send stays in the wallet, unused.</p>
    ${ctaButton(billingUrl, "Top up your wallet", true)}`
    : "";

  const socialText = DIGEST_SOCIAL_LINKS.map((s) => `${s.name}: ${s.url}`).join(
    "\n"
  );

  const topUpTextBlock = payg
    ? `
Two things keep them running
${runConditions.map((row) => `  ${row.label}: ${row.detail}`).join("\n")}

${topUpText}

Only USDC on ${payg.chainName} pays for executions (${payg.assetUrl}). Anything else you send stays in the wallet, unused.

Top up your wallet: ${billingUrl}
`
    : "";

  // Mirrors the HTML: each link follows the paragraph that motivates it. The
  // closing action comes from the pitch, so an org past every published tier
  // gets a way to reach us rather than a pricing page. Orgs with no top-up path
  // keep the billing link at the foot instead.
  const closingLinks = payg
    ? `${upgradePitch.ctaLabel}: ${plainLinkTarget(upgradePitch.ctaUrl)}`
    : `${upgradePitch.ctaLabel}: ${plainLinkTarget(
        upgradePitch.ctaUrl
      )}\nManage billing: ${billingUrl}`;

  const text = `
Hi,

${lead}

${continuityText}
${topUpTextBlock}
${upgradePitch.text}

${closingLinks}

You're receiving this as an owner of ${orgName}.

---
KeeperHub - Blockchain Workflow Automation
${socialText}
`.trim();

  // Clamp the meter so a pay-as-you-go org running well past its quota renders
  // a full bar rather than overflowing the track.
  const barPercent = Math.min(100, Math.max(0, usagePercent));
  const barColor = atLimit ? "#c0392b" : "#e67e22";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <div style="text-align:center; margin:0 0 14px;">
      <div style="color:#999; font-size:11px; font-weight:600; letter-spacing:0.6px; text-transform:uppercase; margin-bottom:6px;">Organization</div>
      <span style="display:inline-block; background:#f5f5f5; border:1px solid #e5e5e5; border-radius:999px; padding:6px 14px; color:#1a1a2e; font-weight:600; font-size:14px;">${escapeHtml(orgName)}</span>
    </div>

    <h2 style="color: #1a1a2e; margin-top: 0;">${heading}</h2>

    <p>${escapeHtml(lead)}</p>

    <div style="background:#f5f5f5; border-radius:8px; padding:20px; margin:24px 0;">
      <div style="display:block; font-size:24px; font-weight:bold; color:${barColor};">${usagePercent}%</div>
      <div style="color:#666; font-size:13px; margin-bottom:12px;">${usedLabel} of ${limitLabel} executions used</div>
      <table role="presentation" width="100%" style="border-collapse:collapse; background:#e5e5e5; border-radius:999px;">
        <tr><td style="width:${barPercent}%; background:${barColor}; border-radius:999px; font-size:0; line-height:8px; height:8px;">&nbsp;</td><td style="font-size:0; line-height:8px; height:8px;">&nbsp;</td></tr>
      </table>
      <div style="color:#999; font-size:12px; margin-top:12px;">Plan: ${escapeHtml(planLabel)} &nbsp;&middot;&nbsp; Quota resets ${resetLabel}</div>
    </div>

    <p>${continuityText}</p>

    ${topUpHtmlBlock}

    <p>${upgradePitch.html}</p>

    ${ctaButton(upgradePitch.ctaUrl, upgradePitch.ctaLabel, !payg)}
  </div>

  <div style="text-align: center; padding: 24px 20px; color: #999; font-size: 12px;">
    <table role="presentation" align="center" style="margin:0 auto 12px;"><tr>${DIGEST_SOCIAL_LINKS.map(
      (s) =>
        `<td style="padding:0 8px;"><a href="${s.url}" target="_blank" rel="noopener"><img src="cid:${s.icon}" alt="${s.name}" width="20" height="20" style="display:block;" /></a></td>`
    ).join("")}</tr></table>
    <p style="margin: 0 0 6px;">You're receiving this as an owner of <strong>${escapeHtml(orgName)}</strong>.</p>
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
    attachments: getDigestSocialAttachments(),
  });

  if (!(success || isTestEnv)) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send quota notification to ${email}`,
      new Error("Failed to send execution quota notification"),
      {
        service: "sendgrid",
        threshold: String(threshold),
      }
    );
  }

  return success;
}
