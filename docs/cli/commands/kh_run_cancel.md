## kh run cancel

Cancel a run

```
kh run cancel <run-id> [flags]
```

### Examples

```
  # Cancel a run (will prompt for confirmation)
  kh r cancel abc123

  # Cancel without prompting
  kh r cancel abc123 --yes
```

### Options

```
  -h, --help   help for cancel
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

* [kh run](kh_run.md)	 - Monitor workflow runs

