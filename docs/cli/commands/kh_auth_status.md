## kh auth status

Show authentication status

```
kh auth status [flags]
```

### Examples

```
  # Show current auth status
  kh auth status

  # Show status as JSON
  kh auth status --json
```

### Options

```
  -h, --help   help for status
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

* [kh auth](kh_auth.md)	 - Authenticate with KeeperHub

