## kh workflow

Manage workflows

### Examples

```
  # List workflows
  kh wf ls

  # Run a workflow
  kh wf run abc123
```

### Options

```
  -h, --help        help for workflow
      --jq string   Filter JSON output with a jq expression
      --json        Output as JSON
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI
* [kh workflow create](kh_workflow_create.md)	 - Create a workflow
* [kh workflow delete](kh_workflow_delete.md)	 - Delete a workflow
* [kh workflow disable](kh_workflow_disable.md)	 - Disable a workflow so it stops running
* [kh workflow enable](kh_workflow_enable.md)	 - Enable a workflow so it runs on its trigger
* [kh workflow get](kh_workflow_get.md)	 - Get a workflow
* [kh workflow go-live](kh_workflow_go-live.md)	 - Publish a workflow
* [kh workflow list](kh_workflow_list.md)	 - List workflows
* [kh workflow run](kh_workflow_run.md)	 - Run a workflow
* [kh workflow update](kh_workflow_update.md)	 - Update a workflow

