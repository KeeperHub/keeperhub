/**
 * System environment variables forwarded to workflow runner pods.
 *
 * When a plugin reads from process.env, the variable MUST be listed here
 * or it will be undefined in K8s Job runner containers.
 *
 * Add new entries when:
 * - A plugin step reads process.env.SOME_KEY
 * - A new system credential is introduced
 */
export const RUNNER_SYSTEM_ENV_VARS = [
  "AI_GATEWAY_API_KEY",
  "CHAIN_RPC_CONFIG",
  "FIRECRAWL_API_KEY",
  "FROM_ADDRESS",
  "GAS_CREDITS_BUSINESS_CENTS",
  "GAS_CREDITS_ENTERPRISE_CENTS",
  "GAS_CREDITS_FREE_CENTS",
  "GAS_CREDITS_PRO_CENTS",
  "LINEAR_API_KEY",
  "LINEAR_TEAM_ID",
  "OPENAI_API_KEY",
  "PIMLICO_API_KEY",
  "PIMLICO_BASE_URL",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "SENDGRID_API_KEY",
  "SIMPLE_ACCOUNT_7702_ADDRESS",
  "SLACK_API_KEY",
] as const;

/**
 * Build env var entries from the current process environment.
 * Skips variables that are not set (undefined).
 */
export function getRunnerSystemEnvVars(): Array<{
  name: string;
  value: string;
}> {
  const vars: Array<{ name: string; value: string }> = [];

  for (const name of RUNNER_SYSTEM_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) {
      vars.push({ name, value });
    }
  }

  return vars;
}
