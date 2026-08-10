## kh auth

Authenticate with KeeperHub

### Examples

```
  # Log in (device code flow — prints a URL and code to confirm in a browser)
  kh auth login

  # Check current auth status
  kh auth status
```

### Options

```
  -h, --help   help for auth
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

* [kh](kh.md)	 - KeeperHub CLI
* [kh auth login](kh_auth_login.md)	 - Log in to KeeperHub
* [kh auth logout](kh_auth_logout.md)	 - Log out of KeeperHub
* [kh auth status](kh_auth_status.md)	 - Show authentication status

