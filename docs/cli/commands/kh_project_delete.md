## kh project delete

Delete a project

```
kh project delete <project-id> [flags]
```

### Examples

```
  # Delete a project (will prompt for confirmation)
  kh p delete abc123

  # Delete without prompting
  kh p delete abc123 --yes
```

### Options

```
  -h, --help   help for delete
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

