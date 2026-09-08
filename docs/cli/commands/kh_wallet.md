## kh wallet

Manage wallets (creator-wallet REST API or agentic-wallet npm package)

### Synopsis

Manage wallets.

Creator wallet (REST):
  kh w balance    show creator-wallet on-chain balances via KeeperHub REST API
  kh w tokens     list supported tokens

Agentic wallet (thin wrappers around npx -p @keeperhub/wallet keeperhub-wallet):
  kh w add        provision a new agentic wallet (no account required)
  kh w info       print agentic subOrgId + walletAddress
  kh w fund       print Coinbase Onramp URL + Tempo deposit address
  kh w link       link agentic wallet to a KeeperHub account (needs KH_SESSION_COOKIE)
  kh w feedback   submit ERC-8004 feedback for a workflow execution this wallet paid for

Prerequisite for agentic subcommands: Node.js (v18+) and npx must be on your PATH.

### Examples

```
  # Creator wallet balance (REST):
  kh w balance

  # Provision an agentic wallet (npx wrapper):
  kh w add

  # Check balance on the agentic wallet directly:
  npx -p @keeperhub/wallet keeperhub-wallet balance
```

### Options

```
  -h, --help        help for wallet
      --jq string   Filter JSON output with a jq expression
      --json        Output as JSON
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI
* [kh wallet add](kh_wallet_add.md)	 - Provision a new agentic wallet (no KeeperHub account required)
* [kh wallet balance](kh_wallet_balance.md)	 - Show wallet balance
* [kh wallet feedback](kh_wallet_feedback.md)	 - Submit ERC-8004 feedback for a workflow execution this wallet paid for
* [kh wallet fund](kh_wallet_fund.md)	 - Print Coinbase Onramp URL (Base USDC) and Tempo deposit address for the agentic wallet
* [kh wallet info](kh_wallet_info.md)	 - Print subOrgId and walletAddress from local agentic wallet config
* [kh wallet link](kh_wallet_link.md)	 - Link the agentic wallet to a KeeperHub account (requires KH_SESSION_COOKIE)
* [kh wallet tokens](kh_wallet_tokens.md)	 - List wallet tokens

