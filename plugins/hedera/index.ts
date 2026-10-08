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
  // Both mirror hosts are compile-time constants and this plugin declares no
  // formFields, so nothing user-supplied can choose the origin: "fixed-host",
  // which stays free. "user-destination" would plan-gate this read-only
  // action behind action.external-request via the catch-all in
  // lib/features/action-egress.ts.
  egress: "fixed-host",
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
        { field: "verified", description: "Whether the payload matches the expected message AND, when an expected submitter is configured, the message was submitted by that account (surrounding whitespace ignored; only asserted when an expected message is provided)" },
        { field: "message", description: "The decoded anchored payload" },
        { field: "consensusTimestamp", description: "Network-assigned consensus timestamp" },
        { field: "payerAccountId", description: "The account that submitted this message, as recorded by the mirror — always exposed, so a workflow can gate on it downstream even without an expected submitter configured" },
        { field: "sequenceNumber", description: "The verified sequence number" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "topicId",
          label: "Topic ID",
          type: "template-input",
          placeholder: "0.0.99999999",
          example: "0.0.99999999",
          required: true,
          helpTip: "The HCS topic to read, e.g. 0.0.99999999.",
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
            "When set, verification succeeds only if the anchored payload matches (surrounding whitespace is ignored on both sides). Leave empty to just read the payload.",
        },
        {
          key: "expectedSubmitter",
          label: "Expected Submitter",
          type: "template-input",
          required: false,
          helpTip:
            "Hedera account id that must have submitted the message (e.g. 0.0.12345). Set this when gating a payment on verified: true — on a topic without a submit key anyone can write matching bytes, so the submitter is what proves authorship. Leave empty to skip the submitter check (it is still reported as payerAccountId).",
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
