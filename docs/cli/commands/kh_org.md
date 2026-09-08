## kh org

Manage organizations

### Examples

```
  # List organizations you belong to
  kh o ls

  # Switch to a different organization
  kh o sw my-org-slug
```

### Options

```
  -h, --help        help for org
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
* [kh org list](kh_org_list.md)	 - List organizations
* [kh org members](kh_org_members.md)	 - List organization members
* [kh org switch](kh_org_switch.md)	 - Switch to an organization

