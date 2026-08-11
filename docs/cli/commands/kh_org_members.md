## kh org members

List organization members

### Synopsis

List organization members.

Requires a browser session. This calls a Better Auth endpoint that resolves a
session cookie and does not inspect the Authorization header, so it returns 401
under an API key regardless of the key's scope - even while the rest of the CLI
works normally with that same key. A 401 here is not a sign that your key is
broken. See 'kh auth-scope'.

```
kh org members [flags]
```

### Examples

```
  # List members in the current organization
  kh o m

  # List as JSON
  kh o m --json
```

### Options

```
  -h, --help   help for members
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

* [kh org](kh_org.md)	 - Manage organizations

