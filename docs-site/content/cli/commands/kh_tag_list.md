## kh tag list

List tags

```
kh tag list [flags]
```

### Examples

```
  # List all tags
  kh t ls

  # List with a higher limit
  kh t ls --limit 50
```

### Options

```
  -h, --help        help for list
      --limit int   Maximum number of tags to list (default 30)
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

* [kh tag](kh_tag.md)	 - Manage tags

