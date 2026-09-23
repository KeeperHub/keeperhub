import type { ActionConfigField, IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { PredgeIcon } from "./icon";

// Wallet whose Predge signal to read. Shared verbatim by address-scoped actions.
const walletField = (): ActionConfigField => ({
  key: "wallet",
  label: "Wallet",
  type: "template-input",
  placeholder: "0x... or {{NodeName.address}}",
  // Only verified smart-money wallets carry a signal, and conviction is a
  // percentile within a set Predge re-ranks, so membership is not permanent:
  // this address was ranked when it was captured and may 404 now. It is an
  // address-shaped example, not a guarantee of a live 200 -- the help text
  // below says so, because `example` also feeds AI workflow generation.
  example: "0x0224bb9eb0a5c9fd261ac9123a72cbdd5748292a",
  helpText:
    "Wallet to read a signal for. Only wallets in Predge's verified smart-money set carry one; " +
    "the set is re-ranked, so a wallet can leave it and the step then fails with \"No Predge signal for this wallet\". " +
    "The prefilled example is illustrative and may no longer be ranked.",
  required: true,
});

const predgePlugin: IntegrationPlugin = {
  type: "predge",
  egress: "user-destination",
  label: "Predge",
  description:
    "Read verifiable smart-money signals from Predge. Before the step succeeds, the signal's ed25519 signature is checked offline against a pinned key, the signed envelope is checked to be the conviction signal for the wallet asked for, and every field the step returns is checked against its documented type and range. A workflow therefore only ever acts on a verified conviction that is a number in 0-100, never on a numeric string, a missing field or an out-of-range value.",

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
        "Optional. Reject an attestation issued more than this many seconds ago. Defaults to 600. " +
        "0 is taken literally and rejects everything, since any network round trip already exceeds it; " +
        "for the strictest usable window set a few seconds, not 0.",
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
        "Fetch a wallet's conviction signal from Predge and verify it offline: pinned ed25519 signer, signature over the canonical payload, the signed `resource` naming the conviction signal for this wallet, subject binding to the wallet, and freshness. The signed payload is then checked field by field: conviction a finite number in 0-100, action one of accumulate/reduce/hold, window one of 7d/30d, each required. The step FAILS on either gate, with the field or the reason in its error, so a successful step is a verified signal whose fields are the documented shape, and there is no `verified` flag to forget to gate on.",
      category: "Predge",
      stepFunction: "readSignalStep",
      stepImportPath: "read-signal",
      outputFields: [
        { field: "success", description: "True only for a signal that verified and whose fields passed their type and range checks; the step errors otherwise" },
        { field: "wallet", description: "The wallet asked for, which the signal was bound to" },
        {
          field: "conviction",
          description: "Predge conviction score from the wallet's on-chain track record; always a number in 0-100, checked before the step succeeds",
        },
        {
          field: "action",
          description: "Recommended action for the wallet; always one of accumulate / reduce / hold",
        },
        { field: "window", description: "Scoring window for the signal; always 7d or 30d" },
        { field: "signer", description: "Hex ed25519 public key the signature verified against (Predge's published key, or your pinned override)" },
        { field: "issuedAt", description: "ISO-8601 issue time carried by the verified attestation" },
        {
          field: "ageSeconds",
          description: "Age of the attestation in seconds at verification time; can be slightly negative within the clock-skew tolerance",
        },
        { field: "error", description: "On failure, why the lookup, the verification or a payload field check did not hold" },
      ],
      configFields: [walletField()],
    },
  ],
};

// Auto-register on import
registerIntegration(predgePlugin);

export default predgePlugin;
