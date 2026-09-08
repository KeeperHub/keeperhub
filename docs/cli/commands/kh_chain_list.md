## kh chain list

List supported blockchain chains

### Synopsis

List supported blockchain chains.

Note the type change if you are copying a chain id into a workflow. This
command reports "chainId" as a JSON number, but web3 workflow nodes expect
config.network as a STRING:

  kh chain list --json   ->   "chainId": 103
  workflow node config   ->   "network": "103"

Writing the number form into a node config is accepted by the API and fails
later at execution time, so it is worth getting right up front.

The list reflects the chains table in the target environment, which is
seeded on deploy. It is the authoritative answer for which chains are live;
the chain-config repo is only an input to that seed.

```
kh chain list [flags]
```

### Examples

```
  # List all chains
  kh ch ls

  # List chains as JSON
  kh ch ls --json

  # Chain id in the string form a workflow node config expects
  kh ch ls --json | jq -r '.[] | select(.name == "Solana Devnet") | .chainId | tostring'
```

### Options

```
  -h, --help   help for list
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

* [kh chain](kh_chain.md)	 - Manage blockchain chains

