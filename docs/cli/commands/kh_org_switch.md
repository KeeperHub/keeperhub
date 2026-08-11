## kh org switch

Switch to an organization

```
kh org switch <org-slug> [flags]
```

### Examples

```
  # Switch to an organization by slug
  kh o sw my-org

  # Find org slugs first
  kh o ls
```

### Options

```
  -h, --help   help for switch
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

