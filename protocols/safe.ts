import { defineAbiProtocol } from "@/lib/protocol-registry";

const SAFE_ABI = JSON.stringify([
  // Functions
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isOwner",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isModuleEnabled",
    stateMutability: "view",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getModulesPaginated",
    stateMutability: "view",
    inputs: [
      { name: "start", type: "address" },
      { name: "pageSize", type: "uint256" },
    ],
    outputs: [
      { name: "array", type: "address[]" },
      { name: "next", type: "address" },
    ],
  },
  // Events
  {
    type: "event",
    name: "AddedOwner",
    inputs: [{ name: "owner", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "RemovedOwner",
    inputs: [{ name: "owner", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "ChangedThreshold",
    inputs: [{ name: "threshold", type: "uint256", indexed: false }],
  },
  {
    type: "event",
    name: "EnabledModule",
    inputs: [{ name: "module", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "DisabledModule",
    inputs: [{ name: "module", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "ChangedGuard",
    inputs: [{ name: "guard", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "ExecutionSuccess",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: false },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ExecutionFailure",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: false },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ApproveHash",
    inputs: [
      { name: "approvedHash", type: "bytes32", indexed: true },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "SignMsg",
    inputs: [{ name: "msgHash", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "ChangedFallbackHandler",
    inputs: [{ name: "handler", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "SafeSetup",
    inputs: [
      { name: "initiator", type: "address", indexed: true },
      { name: "owners", type: "address[]", indexed: false },
      { name: "threshold", type: "uint256", indexed: false },
      { name: "initializer", type: "address", indexed: false },
      { name: "fallbackHandler", type: "address", indexed: false },
    ],
  },
]);

export default defineAbiProtocol({
  name: "Safe",
  slug: "safe",
  description:
    "Safe multisig wallet: read owners, threshold, nonce, and module status for any Safe address",
  website: "https://safe.global",
  icon: "/protocols/safe.png",

  contracts: {
    safe: {
      label: "Safe Multisig",
      userSpecifiedAddress: true,
      addresses: {
        "1": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
        "8453": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
        "42161": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
        "10": "0x41675C099F32341bf84BFc5382aF534df5C7461a",
      },
      abi: SAFE_ABI,
      overrides: {
        getOwners: {
          label: "Get Owners",
          description: "Get the list of owner addresses for a Safe multisig",
          outputs: {
            result: { name: "owners", label: "Owner Addresses" },
          },
        },
        getThreshold: {
          label: "Get Threshold",
          description:
            "Get the number of required confirmations for a Safe transaction",
          outputs: {
            result: { name: "threshold", label: "Required Confirmations" },
          },
        },
        isOwner: {
          label: "Is Owner",
          description: "Check if an address is an owner of the Safe multisig",
          inputs: {
            owner: { label: "Address to Check" },
          },
          outputs: {
            result: { name: "isOwner", label: "Is Owner" },
          },
        },
        nonce: {
          slug: "get-nonce",
          label: "Get Nonce",
          description: "Get the current transaction nonce of the Safe multisig",
          outputs: {
            result: { name: "nonce", label: "Current Nonce" },
          },
        },
        isModuleEnabled: {
          label: "Is Module Enabled",
          description: "Check if a module is enabled on the Safe multisig",
          inputs: {
            module: { label: "Module Address" },
          },
          outputs: {
            result: { name: "isEnabled", label: "Module Enabled" },
          },
        },
        getModulesPaginated: {
          label: "Get Modules Paginated",
          description:
            "Get a paginated list of enabled modules on the Safe multisig",
          inputs: {
            start: {
              label: "Start Address",
              default: "0x0000000000000000000000000000000000000001",
            },
            pageSize: { label: "Page Size", default: "10" },
          },
          outputs: {
            array: { label: "Module Addresses" },
            next: { label: "Next Pagination Address" },
          },
        },
      },
      events: {
        AddedOwner: {
          slug: "added-owner",
          label: "Owner Added",
          description: "Fires when a new owner is added to the Safe",
        },
        RemovedOwner: {
          slug: "removed-owner",
          label: "Owner Removed",
          description: "Fires when an owner is removed from the Safe",
        },
        ChangedThreshold: {
          slug: "changed-threshold",
          label: "Threshold Changed",
          description: "Fires when the confirmation threshold is changed",
        },
        EnabledModule: {
          slug: "enabled-module",
          label: "Module Enabled",
          description: "Fires when a module is enabled on the Safe",
        },
        DisabledModule: {
          slug: "disabled-module",
          label: "Module Disabled",
          description: "Fires when a module is disabled on the Safe",
        },
        ChangedGuard: {
          slug: "changed-guard",
          label: "Guard Changed",
          description: "Fires when the transaction guard is changed",
        },
        ExecutionSuccess: {
          slug: "execution-success",
          label: "Transaction Executed (Success)",
          description: "Fires when a Safe transaction is executed successfully",
        },
        ExecutionFailure: {
          slug: "execution-failure",
          label: "Transaction Executed (Failure)",
          description: "Fires when a Safe transaction execution fails",
        },
        ApproveHash: {
          slug: "approve-hash",
          label: "Hash Approved",
          description: "Fires when an owner approves a transaction hash",
        },
        SignMsg: {
          slug: "sign-msg",
          label: "Message Signed",
          description: "Fires when a message is signed by the Safe",
        },
        ChangedFallbackHandler: {
          slug: "changed-fallback-handler",
          label: "Fallback Handler Changed",
          description: "Fires when the fallback handler is changed",
        },
        SafeSetup: {
          slug: "safe-setup",
          label: "Safe Setup",
          description: "Fires when a new Safe is initialized",
        },
      },
    },
  },
});
