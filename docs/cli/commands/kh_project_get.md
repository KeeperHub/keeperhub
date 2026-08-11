## kh project get

Get a project

```
kh project get <project-id> [flags]
```

### Examples

```
  # Get project details
  kh p g abc123

  # Get as JSON
  kh p g abc123 --json
```

### Options

```
  -h, --help   help for get
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

* [kh project](kh_project.md)	 - Manage projects

