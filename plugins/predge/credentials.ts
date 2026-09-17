export type PredgeCredentials = {
  // Base URL of the Predge signal service. Defaults to the hosted endpoint;
  // override to point at your own Predge deployment or a local dev service.
  PREDGE_SIGNAL_URL?: string;
  // Optional hex ed25519 public key to pin. Overrides Predge's published
  // default key, so a workflow can trust its own deployment's signer. The key
  // the response carries is never trusted on its own.
  //
  // Rotation path: the default pin is a source constant, so the day Predge
  // rotates its signing key, default-configured workflows fail closed
  // ("signer is not the pinned Predge key") until a new plugin version ships
  // the new constant. Set this to the new published key to move ahead of that
  // release; an unset connection has to wait for it.
  PREDGE_SIGNER_KEY_ID?: string;
  // Optional. Reject an attestation issued more than this many seconds ago.
  // Defaults to 600. Raise it only if your signer's clock lags.
  PREDGE_MAX_SIGNAL_AGE_SECONDS?: string;
};
