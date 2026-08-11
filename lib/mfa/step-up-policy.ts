/**
 * Resolves which step-up factors a given action requires for a given user.
 *
 * Rules:
 *  - Email/TOTP users always use dual-factor (TOTP + email) on every gated
 *    action.
 *  - Wallet (SIWE) users require a wallet signature plus every extra factor
 *    they have enrolled (authenticator and/or step-up email). Enrollment is
 *    the only switch: once a wallet user turns a factor on it applies to every
 *    sensitive action. A factor is only enforced when actually enrolled, so a
 *    wallet user with no extra factors is never blocked beyond the signature.
 */

export type StepUpFactor = "wallet" | "totp" | "email";

/** Sensitive actions gated by step-up. Values match the `action` strings
 *  passed to requireStepUp / requireDualFactor across the route handlers. */
export const STEP_UP_ACTIONS = {
  walletWithdraw: "wallet_withdraw",
  walletExportKey: "wallet_export_key",
  // Create and revoke share one challenge: managing an API key is a single
  // sensitive capability from the user's perspective.
  apiKeyManage: "user_api_key_manage",
  orgApiKeyManage: "org_api_key_manage",
  emailChange: "email_change",
  passwordChange: "password_change",
  accountDeactivate: "account_deactivate",
  auditExport: "audit_export",
  agenticWalletApprove: "agentic_wallet_approve",
  agenticWalletReject: "agentic_wallet_reject",
  // Releasing a held Tempo payment moves funds on-chain, so it is step-up gated.
  tempoHeldPaymentBroadcast: "tempo_held_payment_broadcast",
  sessionRevoke: "session_revoke",
  // Internal — step-up gated but not user-facing.
  stepUpEmailEnroll: "step_up_email_enroll",
  stepUpEmailRemove: "step_up_email_remove",
  totpDisable: "totp_disable",
} as const;

export type EnrolledFactors = {
  /** Wallet address linked (SIWE). */
  wallet: boolean;
  /** TOTP authenticator enrolled. */
  totp: boolean;
  /** A verified, deliverable email on file. */
  email: boolean;
};

export function resolveRequiredFactors(params: {
  isWalletUser: boolean;
  enrolled: EnrolledFactors;
}): StepUpFactor[] {
  const { isWalletUser, enrolled } = params;

  // Email/TOTP accounts: mandatory dual-factor.
  if (!isWalletUser) {
    return ["totp", "email"];
  }

  // Wallet accounts: base signature plus every enrolled extra factor. Only
  // enrolled factors are enforced, so a wallet user with none is never blocked.
  const required: StepUpFactor[] = ["wallet"];
  if (enrolled.totp) {
    required.push("totp");
  }
  if (enrolled.email) {
    required.push("email");
  }
  return required;
}
