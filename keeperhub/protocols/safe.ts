import { defineProtocol } from "@/keeperhub/lib/protocol-registry";

export default defineProtocol({
  name: "Safe",
  slug: "safe",
  description:
    "Safe multisig wallet -- read owners, threshold, nonce, and module status for any Safe address",
  website: "https://safe.global",
  icon: "/protocols/safe.png",

  contracts: {
    safe: {
      label: "Safe Multisig",
      userSpecifiedAddress: true,
      // Reference addresses (Safe v1.4.1 Singleton) for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      addresses: {
        // Ethereum Mainnet
        "1": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
        // Base
        "8453": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
        // Arbitrum One
        "42161": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
        // Optimism
        "10": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
      },
    },
  },

  events: [
    {
      slug: "added-owner",
      label: "Owner Added",
      description: "Fires when a new owner is added to the Safe",
      eventName: "AddedOwner",
      contract: "safe",
      inputs: [{ name: "owner", type: "address", indexed: true }],
    },
    {
      slug: "removed-owner",
      label: "Owner Removed",
      description: "Fires when an owner is removed from the Safe",
      eventName: "RemovedOwner",
      contract: "safe",
      inputs: [{ name: "owner", type: "address", indexed: true }],
    },
    {
      slug: "changed-threshold",
      label: "Threshold Changed",
      description: "Fires when the confirmation threshold is changed",
      eventName: "ChangedThreshold",
      contract: "safe",
      inputs: [{ name: "threshold", type: "uint256", indexed: false }],
    },
    {
      slug: "enabled-module",
      label: "Module Enabled",
      description: "Fires when a module is enabled on the Safe",
      eventName: "EnabledModule",
      contract: "safe",
      inputs: [{ name: "module", type: "address", indexed: true }],
    },
    {
      slug: "disabled-module",
      label: "Module Disabled",
      description: "Fires when a module is disabled on the Safe",
      eventName: "DisabledModule",
      contract: "safe",
      inputs: [{ name: "module", type: "address", indexed: true }],
    },
    {
      slug: "changed-guard",
      label: "Guard Changed",
      description: "Fires when the transaction guard is changed",
      eventName: "ChangedGuard",
      contract: "safe",
      inputs: [{ name: "guard", type: "address", indexed: false }],
    },
    {
      slug: "execution-success",
      label: "Transaction Executed (Success)",
      description: "Fires when a Safe transaction is executed successfully",
      eventName: "ExecutionSuccess",
      contract: "safe",
      inputs: [
        { name: "txHash", type: "bytes32", indexed: false },
        { name: "payment", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "execution-failure",
      label: "Transaction Executed (Failure)",
      description: "Fires when a Safe transaction execution fails",
      eventName: "ExecutionFailure",
      contract: "safe",
      inputs: [
        { name: "txHash", type: "bytes32", indexed: false },
        { name: "payment", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "approve-hash",
      label: "Hash Approved",
      description: "Fires when an owner approves a transaction hash",
      eventName: "ApproveHash",
      contract: "safe",
      inputs: [
        { name: "approvedHash", type: "bytes32", indexed: true },
        { name: "owner", type: "address", indexed: true },
      ],
    },
    {
      slug: "sign-msg",
      label: "Message Signed",
      description: "Fires when a message is signed by the Safe",
      eventName: "SignMsg",
      contract: "safe",
      inputs: [{ name: "msgHash", type: "bytes32", indexed: true }],
    },
    {
      slug: "changed-fallback-handler",
      label: "Fallback Handler Changed",
      description: "Fires when the fallback handler is changed",
      eventName: "ChangedFallbackHandler",
      contract: "safe",
      inputs: [{ name: "handler", type: "address", indexed: false }],
    },
    {
      slug: "safe-setup",
      label: "Safe Setup",
      description: "Fires when a new Safe is initialized",
      eventName: "SafeSetup",
      contract: "safe",
      inputs: [
        { name: "initiator", type: "address", indexed: true },
        { name: "owners", type: "address[]", indexed: false },
        { name: "threshold", type: "uint256", indexed: false },
        { name: "initializer", type: "address", indexed: false },
        { name: "fallbackHandler", type: "address", indexed: false },
      ],
    },
  ],

  actions: [
    // Ownership

    {
      slug: "get-owners",
      label: "Get Owners",
      description: "Get the list of owner addresses for a Safe multisig",
      type: "read",
      contract: "safe",
      function: "getOwners",
      inputs: [],
      outputs: [
        {
          name: "owners",
          type: "address[]",
          label: "Owner Addresses",
        },
      ],
    },
    {
      slug: "get-threshold",
      label: "Get Threshold",
      description:
        "Get the number of required confirmations for a Safe transaction",
      type: "read",
      contract: "safe",
      function: "getThreshold",
      inputs: [],
      outputs: [
        {
          name: "threshold",
          type: "uint256",
          label: "Required Confirmations",
        },
      ],
    },
    {
      slug: "is-owner",
      label: "Is Owner",
      description: "Check if an address is an owner of the Safe multisig",
      type: "read",
      contract: "safe",
      function: "isOwner",
      inputs: [{ name: "owner", type: "address", label: "Address to Check" }],
      outputs: [
        {
          name: "isOwner",
          type: "bool",
          label: "Is Owner",
        },
      ],
    },

    // Transaction State

    {
      slug: "get-nonce",
      label: "Get Nonce",
      description: "Get the current transaction nonce of the Safe multisig",
      type: "read",
      contract: "safe",
      function: "nonce",
      inputs: [],
      outputs: [
        {
          name: "nonce",
          type: "uint256",
          label: "Current Nonce",
        },
      ],
    },

    // Modules

    {
      slug: "is-module-enabled",
      label: "Is Module Enabled",
      description: "Check if a module is enabled on the Safe multisig",
      type: "read",
      contract: "safe",
      function: "isModuleEnabled",
      inputs: [{ name: "module", type: "address", label: "Module Address" }],
      outputs: [
        {
          name: "isEnabled",
          type: "bool",
          label: "Module Enabled",
        },
      ],
    },
    {
      slug: "get-modules-paginated",
      label: "Get Modules Paginated",
      description:
        "Get a paginated list of enabled modules on the Safe multisig",
      type: "read",
      contract: "safe",
      function: "getModulesPaginated",
      inputs: [
        {
          name: "start",
          type: "address",
          label: "Start Address",
          default: "0x0000000000000000000000000000000000000001",
        },
        {
          name: "pageSize",
          type: "uint256",
          label: "Page Size",
          default: "10",
        },
      ],
      outputs: [
        {
          name: "array",
          type: "address[]",
          label: "Module Addresses",
        },
        {
          name: "next",
          type: "address",
          label: "Next Pagination Address",
        },
      ],
    },
  ],
});
