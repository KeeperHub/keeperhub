## kh workflow update

Update a workflow

### Synopsis

Update a workflow.

Nodes and edges can only be supplied as a file. Unlike 'kh workflow create',
there are no inline --nodes / --edges flags here.

The file is a JSON OBJECT holding both keys, not a bare array of nodes:

  {"nodes": [...], "edges": [...]}

Both keys are sent together, so --nodes-file replaces the whole graph. To
change one node, fetch the current definition first:

  kh workflow get <id> --json > workflow.json

Node config is only lightly checked on the way in. An integrationId that
matches no integration is accepted (the API treats unknown ids as stale-but-
savable references), and "network" and "actionType" are not validated at all.
A successful update is not evidence that the workflow runs - misconfiguration
surfaces at execution time.

```
kh workflow update <workflow-id> [flags]
```

### Examples

```
  # Update workflow name
  kh wf update abc123 --name "New Name"

  # Update nodes from file - the file is an object, not an array:
  #   {"nodes": [ ... ], "edges": [ ... ]}
  kh wf update abc123 --nodes-file workflow.json

  # Assign the workflow to a project and tag
  kh wf update abc123 --project proj_123 --tag tag_456

  # Remove the workflow from its project (pass an empty value)
  kh wf update abc123 --project ""
```

### Options

```
      --description string   New workflow description
  -h, --help                 help for update
      --name string          New workflow name
      --nodes-file string    Path to a JSON file shaped {"nodes": [...], "edges": [...]}; replaces the whole graph
      --project string       Project ID to assign (empty value unassigns)
      --tag string           Tag ID to assign (empty value unassigns)
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

