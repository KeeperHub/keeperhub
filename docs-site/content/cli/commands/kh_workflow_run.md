## kh workflow run

Run a workflow

### Synopsis

Run triggers a workflow execution. By default the command returns the
execution ID immediately. Use --wait to block until the run completes
or times out (default timeout: 5 minutes).

See also: kh r st, kh r l

```
kh workflow run <workflow-id> [flags]
```

### Examples

```
  # Run a workflow
  kh wf run abc123

  # Run and wait for completion
  kh wf run abc123 --wait --timeout 2m
```

### Options

```
  -h, --help               help for run
      --timeout duration   Timeout when using --wait (default 5m0s)
      --wait               Wait for completion
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

* [kh workflow](kh_workflow.md)	 - Manage workflows

