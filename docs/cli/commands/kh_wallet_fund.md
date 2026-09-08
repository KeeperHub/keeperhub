## kh wallet fund

Print Coinbase Onramp URL (Base USDC) and Tempo deposit address for the agentic wallet

### Synopsis

Print a Coinbase Onramp URL for Base USDC funding plus the Tempo deposit address.

Thin wrapper around `npx -p @keeperhub/wallet keeperhub-wallet fund`. No HTTP calls, no browser launch --
prints copy-paste instructions only.

```
kh wallet fund [flags]
```

### Options

```
  -h, --help   help for fund
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --jq string     Filter JSON output with a jq expression
      --json          Output as JSON
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh wallet](kh_wallet.md)	 - Manage wallets (creator-wallet REST API or agentic-wallet npm package)

