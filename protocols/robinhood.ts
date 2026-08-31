import { defineProtocol } from "@/lib/protocol-registry";

// Hub-only protocol entry: surfaces Robinhood in Hub > Protocols alongside
// Safe, Aave, etc. The runtime actions live in the `robinhood` plugin in
// plugins/robinhood/ (stock-token reads plus a USDG swap on Robinhood Chain).
// The `hubOnly: true` flag tells discover-plugins NOT to register this as an
// integration plugin, so the plugin's actions remain the source of truth in
// the workflow editor's action grid. The slug matches the plugin
// type, which is what lets withPluginActions() graft those actions onto the
// Hub card and detail modal.
export default defineProtocol({
  name: "Robinhood",
  slug: "robinhood",
  description:
    "Tokenised equities on Robinhood Chain. Read a stock token's price, a holder's position in share terms, and whether the market behind the token is currently tradeable. Read-only today; there are no write actions.",
  website: "https://robinhood.com",
  icon: "/protocols/robinhood.png",
  hubOnly: true,
  contracts: {},
  actions: [],
});
