## kh workflow create

Create a workflow

### Synopsis

Create a workflow.

Nodes and edges can be supplied two ways, and the two take different shapes:

  --nodes-file FILE   a JSON OBJECT: {"nodes": [...], "edges": [...]}
  --nodes / --edges   bare JSON ARRAYS, passed separately

Inline flags override the file when both are given. 'kh workflow update' accepts
only --nodes-file, so a file is the portable choice if you intend to edit the
workflow later.

New workflows are created DISABLED. There is no --enabled flag; enable the
workflow in the web app, or PATCH "enabled": true against the API directly.

Node config is only lightly checked on the way in. An integrationId that
matches no integration is accepted (the API treats unknown ids as stale-but-
savable references), and "network" and "actionType" are not validated at all.
A successful create is not evidence that the workflow runs - misconfiguration
surfaces at execution time.

```
kh workflow create [flags]
```

### Examples

```
  # Create an empty workflow
  kh wf create --name "My Workflow"

  # Create with nodes from a JSON file - the file is an object, not an array:
  #   {"nodes": [ ... ], "edges": [ ... ]}
  kh wf create --name "DeFi Monitor" --nodes-file workflow.json

  # Create with inline JSON nodes - these flags take bare arrays
  kh wf create --name "Test" --nodes '[{"id":"t1","type":"trigger","position":{"x":0,"y":0},"data":{"type":"trigger","config":{"triggerType":"Manual"}}}]'

  # Create inside a project and label it with a tag
  kh wf create --name "Payouts" --project proj_123 --tag tag_456
```

### Options

```
      --description string   Workflow description
      --edges string         Inline JSON array of edges (overrides --nodes-file)
  -h, --help                 help for create
      --name string          Workflow name (required)
      --nodes string         Inline JSON array of nodes (overrides --nodes-file)
      --nodes-file string    Path to a JSON file shaped {"nodes": [...], "edges": [...]}
      --project string       Project ID to assign the workflow to
      --tag string           Tag ID to label the workflow
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

