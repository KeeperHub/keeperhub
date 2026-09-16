import type { ActionConfigField, IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { PredgeIcon } from "./icon";

// Wallet whose Predge signal to read. Shared verbatim by address-scoped actions.
const walletField = (): ActionConfigField => ({
  key: "wallet",
  label: "Wallet",
  type: "template-input",
  placeholder: "0x... or {{NodeName.address}}",
  example: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  required: true,
});

const predgePlugin: IntegrationPlugin = {
  type: "predge",
  egress: "user-destination",
  label: "Predge",
  description:
    "Read verifiable smart-money signals from Predge and gate a workflow on the signature",

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
        "Optional. Overrides Predge's published signing key with your own deployment's key. Leave blank to verify against Predge's published key. The key the response carries is never trusted on its own.",
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
        "Fetch a wallet's conviction signal from Predge and verify it offline: pinned ed25519 signer, signature over the canonical payload, subject binding to the wallet, and freshness. Gate execution on the `verified` output.",
      category: "Predge",
      stepFunction: "readSignalStep",
      stepImportPath: "read-signal",
      outputFields: [
        { field: "success", description: "Whether the lookup succeeded" },
        { field: "wallet", description: "The wallet the signal is about" },
        {
          field: "conviction",
          description: "Predge conviction score (0-100) from the wallet's on-chain track record",
        },
        {
          field: "action",
          description: "Recommended action for the wallet (accumulate / reduce / hold)",
        },
        { field: "window", description: "Scoring window for the signal (7d / 30d)" },
        {
          field: "verified",
          description:
            "True only when the signal is signed by the pinned Predge key, the signature matches, the payload is about the requested wallet, and it is fresh. Gate execution on this being true.",
        },
        {
          field: "reason",
          description: "Why verification failed, when it did. Empty on a clean pass.",
        },
        { field: "signer", description: "Hex ed25519 public key the attestation claims to be signed by" },
        {
          field: "subjectMatch",
          description: "Whether the signed payload is about the requested wallet",
        },
        { field: "issuedAt", description: "ISO-8601 issue time carried by the attestation" },
        {
          field: "ageSeconds",
          description: "Age of the attestation in seconds at verification time (-1 if unknown)",
        },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [walletField()],
    },
  ],
};

// Auto-register on import
registerIntegration(predgePlugin);

export default predgePlugin;
