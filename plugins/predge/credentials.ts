export type PredgeCredentials = {
  // Base URL of the Predge signal service. Defaults to the hosted endpoint;
  // override to point at your own Predge deployment or a local dev service.
  PREDGE_SIGNAL_URL?: string;
  // Optional hex ed25519 public key to pin. When set, only signals signed by
  // this key verify -- so a swapped signer is rejected even if its own
  // signature is internally valid.
  PREDGE_SIGNER_KEY_ID?: string;
};
