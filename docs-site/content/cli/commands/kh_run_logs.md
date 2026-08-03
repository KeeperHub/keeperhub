## kh run logs

Show logs for a run

```
kh run logs <run-id> [flags]
```

### Examples

```
  # Show step logs for a run
  kh r l abc123

  # Show logs as JSON
  kh r l abc123 --json
```

### Options

```
  -h, --help   help for logs
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

