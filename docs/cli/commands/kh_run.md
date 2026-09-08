## kh run

Monitor workflow runs

### Examples

```
  # Show status of a run
  kh r st abc123

  # Show step-by-step logs
  kh r l abc123
```

### Options

```
  -h, --help   help for run
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

* [kh](kh.md)	 - KeeperHub CLI
* [kh run cancel](kh_run_cancel.md)	 - Cancel a run
* [kh run logs](kh_run_logs.md)	 - Show logs for a run
* [kh run status](kh_run_status.md)	 - Show the status of a run

