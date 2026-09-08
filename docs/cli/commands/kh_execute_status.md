## kh execute status

Show the status of an execution

### Synopsis

Show the status of a direct blockchain execution (transfer or contract call).
Use --watch to poll until the execution reaches a terminal state. Unconfirmed
is terminal: the transaction was broadcast but no receipt could be read yet,
and the reconciler keeps watching it, so re-check the execution later.

Use --require-verified to fail unless the execution completed AND every
onchain receipt is chain-verified with receiptStatus "success". A completed
status without receipts exits non-zero: nothing was submitted, so there is
nothing to chain-verify. An unconfirmed status exits non-zero as well: a
broadcast with no readable receipt is not proof the transaction landed.

See also: kh r st, kh ex transfer, kh ex cc

```
kh execute status <execution-id> [flags]
```

### Examples

```
  # Show execution status
  kh ex st abc123

  # Watch until completion
  kh ex st abc123 --watch

  # Gate a script on chain-verified success. --watch polls until the
  # execution reaches a terminal status and has no deadline of its own,
  # so bound it externally when running unattended.
  kh ex st abc123 --watch --require-verified && ./next-step.sh
```

### Options

```
  -h, --help               help for status
      --require-verified   Exit non-zero unless completed with chain-verified success receipts
      --watch              Live-update until complete
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

* [kh execute](kh_execute.md)	 - Execute direct blockchain actions

