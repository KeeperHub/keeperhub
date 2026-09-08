## kh wallet tokens

List wallet tokens

```
kh wallet tokens [flags]
```

### Examples

```
  # List supported tokens
  kh w tokens

  # Filter to a specific chain
  kh w tokens --chain 1
```

### Options

```
      --chain string   Filter by chain
  -h, --help           help for tokens
      --limit int      Maximum number of tokens to list (default 50)
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

