## kh tag create

Create a tag

```
kh tag create <name> [flags]
```

### Examples

```
  # Create a tag with default color
  kh t create "defi"

  # Create a tag with a custom color
  kh t create "urgent" --color "#ef4444"
```

### Options

```
      --color string   Tag color (default: #6366f1) (default "#6366f1")
  -h, --help           help for create
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

