import {
  queryErrorOutput,
  querySuccessOutput,
} from "@/plugins/field-fragments";
import type { ActionConfigField, IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { HyperliquidIcon } from "./icon";

// Config fields shared verbatim by more than one Hyperliquid action. Factories
// return fresh objects so no field instance is aliased across actions.
const userAddressField = (): ActionConfigField => ({
  key: "user",
  label: "User Address",
  type: "template-input",
  placeholder: "0x... or {{NodeName.address}}",
  example: "0x0000000000000000000000000000000000000000",
  required: true,
  isAddressField: true,
});

const coinField = (): ActionConfigField => ({
  key: "coin",
  label: "Coin",
  type: "template-input",
  placeholder: "BTC, ETH, SOL ...",
  example: "BTC",
  required: true,
});

const hyperliquidPlugin: IntegrationPlugin = {
  type: "hyperliquid",
  egress: "fixed-host",
  label: "Hyperliquid",
  description:
    "Read-only wrappers over the Hyperliquid Info REST API for vault operator reporting, validator monitoring, and account state queries.",

  icon: HyperliquidIcon,

  requiresCredentials: false,

  formFields: [
    {
      id: "info",
      label: "Hyperliquid Info API",
      type: "text",
      placeholder: "No configuration needed",
      configKey: "info",
      helpText:
        "The Hyperliquid Info REST API is public and requires no authentication. Actions call https://api.hyperliquid.xyz/info directly.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testHyperliquid } = await import("./test");
      return testHyperliquid;
    },
  },

  actions: [
    {
      slug: "clearinghouse-state",
      label: "Get Clearinghouse State",
      description:
        "Get a user's perpetuals account summary including open positions, margin details, and account value.",
      category: "Hyperliquid",
      stepFunction: "clearinghouseStateStep",
      stepImportPath: "clearinghouse-state",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Clearinghouse state JSON: marginSummary, assetPositions, withdrawable, time",
        },
        queryErrorOutput(),
      ],
      configFields: [
        userAddressField(),
        {
          key: "dex",
          label: "Builder DEX",
          type: "template-input",
          placeholder: "Optional builder-deployed perp DEX name",
          helpTip:
            "Leave empty for the standard Hyperliquid perpetuals exchange. Only set for builder-deployed perp DEXes (HIP-3).",
        },
      ],
    },
    {
      slug: "vault-details",
      label: "Get Vault Details",
      description:
        "Get vault metadata including name, leader, portfolio history, APR, followers, and equity allocation.",
      category: "Hyperliquid",
      stepFunction: "vaultDetailsStep",
      stepImportPath: "vault-details",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Vault details JSON: name, leader, vaultAddress, portfolio, apr, followers, relationship",
        },
        queryErrorOutput(),
      ],
      configFields: [
        {
          key: "vaultAddress",
          label: "Vault Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.vaultAddress}}",
          example: "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303",
          required: true,
          isAddressField: true,
        },
        {
          key: "user",
          label: "User Address",
          type: "template-input",
          placeholder: "Optional - returns follower-specific data if provided",
          helpTip:
            "Optional user address. If provided, the response includes the user's relationship to the vault (e.g. follower equity).",
          isAddressField: true,
        },
      ],
    },
    {
      slug: "validator-summaries",
      label: "Get Validator Summaries",
      description:
        "Get summaries for all Hyperliquid validators including stake, jailed status, commission, and uptime statistics.",
      category: "Hyperliquid",
      stepFunction: "validatorSummariesStep",
      stepImportPath: "validator-summaries",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Array of validator summaries with validator, signer, name, stake, isJailed, isActive, commission, stats",
        },
        queryErrorOutput(),
      ],
      configFields: [],
    },
    {
      slug: "funding-history",
      label: "Get Funding History",
      description:
        "Get historical funding rate records for a coin between two timestamps.",
      category: "Hyperliquid",
      stepFunction: "fundingHistoryStep",
      stepImportPath: "funding-history",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Array of funding records: coin, fundingRate, premium, time (ms)",
        },
        queryErrorOutput(),
      ],
      configFields: [
        coinField(),
        {
          key: "startTime",
          label: "Start Time (ms)",
          type: "template-input",
          placeholder: "Unix timestamp in milliseconds",
          example: "1700000000000",
          required: true,
        },
        {
          key: "endTime",
          label: "End Time (ms)",
          type: "template-input",
          placeholder: "Optional Unix timestamp in milliseconds",
          helpTip:
            "Optional end of the funding window. Defaults to the latest record if omitted.",
        },
      ],
    },
    {
      slug: "spot-deploy-state",
      label: "Get Spot Deploy State",
      description:
        "Get spot token deployment auction state and gas auction details for a user.",
      category: "Hyperliquid",
      stepFunction: "spotDeployStateStep",
      stepImportPath: "spot-deploy-state",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Spot deploy state JSON: states (token deployments), gasAuction (start, duration, gas params)",
        },
        queryErrorOutput(),
      ],
      configFields: [
        userAddressField(),
      ],
    },
    {
      slug: "referral",
      label: "Get Referral State",
      description:
        "Get referral status, cumulative volume, claimed and unclaimed rewards, and referee list for a user.",
      category: "Hyperliquid",
      stepFunction: "referralStep",
      stepImportPath: "referral",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Referral JSON: referredBy, cumVlm, unclaimedRewards, claimedRewards, builderRewards, referrerState",
        },
        queryErrorOutput(),
      ],
      configFields: [
        userAddressField(),
      ],
    },
    {
      slug: "sub-accounts",
      label: "Get Sub-Accounts",
      description:
        "Get all sub-accounts for a master user, including names, addresses, and per-subaccount clearinghouse state.",
      category: "Hyperliquid",
      stepFunction: "subAccountsStep",
      stepImportPath: "sub-accounts",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Array of sub-accounts with name, subAccountUser, master, and clearinghouseState",
        },
        queryErrorOutput(),
      ],
      configFields: [
        {
          key: "user",
          label: "Master Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x0000000000000000000000000000000000000000",
          required: true,
          isAddressField: true,
        },
      ],
    },
    {
      slug: "active-asset-data",
      label: "Get Active Asset Data",
      description:
        "Get a user's active asset context for a coin: leverage settings, max trade sizes, available balance, and mark price.",
      category: "Hyperliquid",
      stepFunction: "activeAssetDataStep",
      stepImportPath: "active-asset-data",
      outputFields: [
        querySuccessOutput(),
        {
          field: "data",
          description:
            "Active asset data JSON: user, coin, leverage, maxTradeSzs, availableToTrade, markPx",
        },
        queryErrorOutput(),
      ],
      configFields: [
        userAddressField(),
        coinField(),
      ],
    },
  ],
};

registerIntegration(hyperliquidPlugin);

export default hyperliquidPlugin;
