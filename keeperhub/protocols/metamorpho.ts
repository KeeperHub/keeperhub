import { defineProtocol } from "@/keeperhub/lib/protocol-registry";
import { erc4626VaultActions } from "@/keeperhub/lib/standards/erc4626";

export default defineProtocol({
  name: "MetaMorpho",
  slug: "metamorpho",
  description:
    "MetaMorpho ERC-4626 vaults -- curated lending vaults built on Morpho Blue, managed by risk curators like Steakhouse, Gauntlet, and Re7",
  website: "https://app.morpho.org",
  icon: "/protocols/metamorpho.png",

  contracts: {
    vault: {
      label: "MetaMorpho Vault",
      addresses: {},
      userSpecifiedAddress: true,
    },
  },

  actions: [...erc4626VaultActions("vault")],
});
