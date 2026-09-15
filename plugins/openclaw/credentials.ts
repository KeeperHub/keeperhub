export type OpenClawCredentials = {
  /** Public base URL of the OpenClaw instance, e.g. https://claw.example.com */
  OPENCLAW_BASE_URL?: string;
  /** Dedicated hook token. Must be distinct from the Gateway shared secret. */
  OPENCLAW_HOOK_TOKEN?: string;
};
