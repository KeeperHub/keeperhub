## kh wallet info

Print subOrgId and walletAddress from local agentic wallet config

### Synopsis

Print subOrgId and walletAddress from ~/.keeperhub/wallet.json.

Thin wrapper around `npx -p @keeperhub/wallet keeperhub-wallet info`. Exits non-zero if the config is missing.

```
kh wallet info [flags]
```

### Options

```
  -h, --help   help for info
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

