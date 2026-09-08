## kh workflow get

Get a workflow

```
kh workflow get <workflow-id> [flags]
```

### Examples

```
  # Get workflow details
  kh wf g abc123

  # Get as JSON
  kh wf g abc123 --json
```

### Options

```
  -h, --help   help for get
      --web    Open the workflow in the browser
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

