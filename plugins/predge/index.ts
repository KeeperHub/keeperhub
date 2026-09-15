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
        "Optional. When set, only signals signed by this key verify. Leave blank to accept any key the signal carries.",
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
        "Fetch a wallet's conviction signal from Predge and verify its ed25519 signature offline. Gate execution on the `verified` output.",
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
            "Whether the ed25519 signature verified offline. Gate execution on this being true.",
        },
        { field: "signer", description: "Hex ed25519 public key that signed the signal" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [walletField()],
    },
  ],
};

// Auto-register on import
registerIntegration(predgePlugin);

export default predgePlugin;
