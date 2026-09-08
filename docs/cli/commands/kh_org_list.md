## kh org list

List organizations

### Synopsis

List organizations.

Requires a browser session. The underlying endpoint resolves a session cookie
and does not inspect the Authorization header, so this command returns 401
under an API key regardless of the key's scope - even while 'kh workflow list'
and the rest of the CLI work normally with that same key. A 401 here is not a
sign that your key is broken. See 'kh auth-scope'.

```
kh org list [flags]
```

### Examples

```
  # List all organizations
  kh o ls

  # List as JSON
  kh o ls --json
```

### Options

```
  -h, --help   help for list
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

