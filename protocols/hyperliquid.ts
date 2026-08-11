import { defineProtocol } from "@/lib/protocol-registry";

// Hub-only protocol entry: surfaces Hyperliquid in Hub > Protocols
// alongside Safe, Aave, etc. The runtime actions for Hyperliquid today
// live in the `hyperliquid` plugin in plugins/hyperliquid/ (read-only
// Info REST API). The `hubOnly: true` flag tells discover-plugins NOT
// to register this as an integration plugin, so the plugin's 8 actions
// remain the source of truth in the workflow editor's action grid.
//
// Forward-looking: once HyperEVM on-chain support lands, drop the
// `hubOnly` flag and add real `contracts` + `actions` here. The plugin
// can then either coexist (different action slugs) or be merged.
//
// Icon at public/protocols/hyperliquid.png — replace with the official
// Hyperliquid wordmark whenever brand-asset clearance is available.
export default defineProtocol({
  name: "Hyperliquid",
  slug: "hyperliquid",
  description:
    "Perpetuals, spot, vaults, and validators on the Hyperliquid L1. Today, query Hyperliquid via the Hyperliquid plugin (Info REST API). On-chain HyperEVM read/write actions are coming soon.",
  website: "https://hyperliquid.xyz",
  icon: "/protocols/hyperliquid.png",
  hubOnly: true,
  contracts: {},
  actions: [],
});
