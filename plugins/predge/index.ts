import type { ActionConfigField, IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { PredgeIcon } from "./icon";

// Wallet whose Predge signal to read. Shared verbatim by address-scoped actions.
const walletField = (): ActionConfigField => ({
  key: "wallet",
  label: "Wallet",
  type: "template-input",
  placeholder: "0x... or {{NodeName.address}}",
  // A wallet Predge currently ranks, so the example returns a live signed
  // signal rather than a 404 (only verified smart-money wallets carry one).
  example: "0x0224bb9eb0a5c9fd261ac9123a72cbdd5748292a",
  required: true,
});

const predgePlugin: IntegrationPlugin = {
  type: "predge",
  egress: "user-destination",
  label: "Predge",
  description:
    "Read verifiable smart-money signals from Predge. The signal's ed25519 signature is checked offline against a pinned key before the step succeeds, so a workflow only ever acts on a verified number.",

  icon: PredgeIcon,

  // Works against the hosted Predge signal service without credentials. Add a
  // connection to point at your own deployment or pin a specific signing key.
  requiresCredentials: false,

  formFields: [
    {
      id: "signalUrl",
      label: "Predge Signal URL",
      type: "url",
      placeholder: "https://api.predge.io",
      configKey: "PREDGE_SIGNAL_URL",
      envVar: "PREDGE_SIGNAL_URL",
      helpText: "Base URL of the Predge signal service to query. ",
      helpLink: {
        text: "predge.io",
        url: "https://predge.io",
      },
    },
    {
      id: "signerKeyId",
      label: "Pinned Signer Key (optional)",
      type: "text",
      placeholder: "hex ed25519 public key",
      configKey: "PREDGE_SIGNER_KEY_ID",
      envVar: "PREDGE_SIGNER_KEY_ID",
      helpText:
        "Optional. Overrides Predge's published signing key with your own deployment's key. Leave blank to verify against Predge's published key. The key the response carries is never trusted on its own. If steps start failing with \"signer is not the pinned Predge key\", Predge has rotated its key: put the new published key here to keep running until a plugin version ships with it.",
    },
    {
      id: "maxSignalAgeSeconds",
      label: "Max Signal Age, seconds (optional)",
      type: "text",
      placeholder: "600",
      configKey: "PREDGE_MAX_SIGNAL_AGE_SECONDS",
      envVar: "PREDGE_MAX_SIGNAL_AGE_SECONDS",
      helpText:
        "Optional. Reject an attestation issued more than this many seconds ago. Defaults to 600.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testPredge } = await import("./test");
      return testPredge;
    },
  },

  actions: [
    {
      slug: "read-signal",
      label: "Read Predge Signal",
      description:
        "Fetch a wallet's conviction signal from Predge and verify it offline: pinned ed25519 signer, signature over the canonical payload, subject binding to the wallet, and freshness. The step FAILS if verification does not hold, with the reason in its error, so a successful step is a verified signal and there is no `verified` flag to forget to gate on.",
      category: "Predge",
      stepFunction: "readSignalStep",
      stepImportPath: "read-signal",
      outputFields: [
        { field: "success", description: "True only for a signal that verified; the step errors otherwise" },
        { field: "wallet", description: "The wallet asked for, which the signal was bound to" },
        {
          field: "conviction",
          description: "Predge conviction score (0-100) from the wallet's on-chain track record",
        },
        {
          field: "action",
          description: "Recommended action for the wallet (accumulate / reduce / hold)",
        },
        { field: "window", description: "Scoring window for the signal (7d / 30d)" },
        { field: "signer", description: "Hex ed25519 public key the signature verified against (Predge's published key, or your pinned override)" },
        { field: "issuedAt", description: "ISO-8601 issue time carried by the verified attestation" },
        {
          field: "ageSeconds",
          description: "Age of the attestation in seconds at verification time; can be slightly negative within the clock-skew tolerance",
        },
        { field: "error", description: "On failure, why the lookup or verification did not hold" },
      ],
      configFields: [walletField()],
    },
  ],
};

// Auto-register on import
registerIntegration(predgePlugin);

export default predgePlugin;
