import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { HederaIcon } from "./icon";

/**
 * Hedera plugin — verify workflow output against Hedera's public consensus.
 *
 * Read-only by design: `verify-message` queries the public HCS mirror node
 * over safeFetch, so this plugin adds no server dependencies. A workflow can
 * gate on `verified: true` knowing the proof comes from the Hedera network
 * itself, not from the system that anchored the message.
 */
const hederaPlugin: IntegrationPlugin = {
  type: "hedera",
  egress: "user-destination",
  label: "Hedera",
  description:
    "Verify messages on Hedera Consensus Service via the public mirror node",

  icon: HederaIcon,

  // The verify action is a public read; no connection required.
  requiresCredentials: false,

  formFields: [],

  testConfig: {
    getTestFunction: async () => {
      const { testHedera } = await import("./test");
      return testHedera;
    },
  },

  actions: [
    {
      slug: "verify-message",
      label: "Verify HCS Message",
      description:
        "Read a message from an HCS topic via the public mirror node and check it against an expected payload",
      category: "Hedera",
      stepFunction: "verifyMessageStep",
      stepImportPath: "verify-message",
      outputFields: [
        { field: "success", description: "Whether the verification query completed" },
        { field: "found", description: "Whether the mirror holds a message at this sequence (empty payloads count as found)" },
        { field: "verified", description: "Whether the payload matches the expected message exactly (when one is provided)" },
        { field: "message", description: "The decoded anchored payload" },
        { field: "consensusTimestamp", description: "Network-assigned consensus timestamp" },
        { field: "sequenceNumber", description: "The verified sequence number" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "topicId",
          label: "Topic ID",
          type: "template-input",
          placeholder: "0.0.10590142",
          example: "0.0.10590142",
          required: true,
          helpTip: "The HCS topic to read, e.g. 0.0.10590142.",
        },
        {
          key: "sequenceNumber",
          label: "Sequence Number",
          type: "template-input",
          placeholder: "18",
          example: "18",
          required: true,
          helpTip: "The topic sequence number to verify.",
        },
        {
          key: "expectedMessage",
          label: "Expected Message",
          type: "template-input",
          required: false,
          helpTip:
            "When set, verification succeeds only if the anchored payload matches exactly. Leave empty to just read the payload.",
        },
        {
          key: "network",
          label: "Network",
          type: "select",
          required: true,
          options: [
            { value: "testnet", label: "Testnet" },
            { value: "mainnet", label: "Mainnet" },
          ],
          defaultValue: "testnet",
          example: "testnet",
          helpTip: "Which Hedera network's public mirror node to query.",
        },
      ],
    },
  ],
};

registerIntegration(hederaPlugin);

export default hederaPlugin;
