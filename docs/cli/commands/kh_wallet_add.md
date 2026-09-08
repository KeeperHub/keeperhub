## kh wallet add

Provision a new agentic wallet (no KeeperHub account required)

### Synopsis

Provision a new agentic wallet by calling POST /api/agentic-wallet/provision.

This is a thin wrapper around `npx -p @keeperhub/wallet keeperhub-wallet add` -- the npm package is the
canonical tool. Writes {subOrgId, walletAddress, hmacSecret} to ~/.keeperhub/wallet.json
(chmod 0o600) and prints subOrgId + walletAddress (hmacSecret is NEVER printed).

```
kh wallet add [flags]
```

### Options

```
  -h, --help   help for add
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

