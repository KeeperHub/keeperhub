## kh doctor

Check CLI health

### Synopsis

Run diagnostic checks against your KeeperHub configuration and API
connectivity. Checks auth validity, API reachability, organization wallet
status, agentic wallet status and credit, spend cap, chain availability,
and CLI version.

The agentic wallet check signs its request with the HMAC secret in
~/.keeperhub/wallet.json, so it reports only the wallet held on this machine.
The secret is never printed.

See also: kh auth status, kh version

```
kh doctor [flags]
```

### Examples

```
  # Run all health checks
  kh doctor

  # Output results as JSON
  kh doctor --json
```

### Options

```
  -h, --help   help for doctor
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

