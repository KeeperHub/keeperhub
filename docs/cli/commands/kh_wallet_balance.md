## kh wallet balance

Show wallet balance

```
kh wallet balance [flags]
```

### Examples

```
  # Show balances for all chains
  kh w balance

  # Filter to a specific chain
  kh w balance --chain Ethereum
```

### Options

```
      --chain string   Filter by chain
  -h, --help           help for balance
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

