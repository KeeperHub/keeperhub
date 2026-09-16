# KeeperHub PRs - Issues to Address

## PR #2440: feat: derive protocol output field paths from ABI structure
**URL:** https://github.com/KeeperHub/keeperhub/pull/2440
**Status:** CHANGES_REQUESTED (2 reviewers)
**Last Update:** Fixed in commit 9b0ddba96

### Issues Reported:
✅ **FIXED - Blocking 1:** Override lookup was using wrong key (`abiName` instead of authoring-time keys like `result`, `result0`, `result1`)
- Affected 113 occurrences across 27 protocol files
- Now fixed to use authoring-time keys matching protocol-derive.ts

✅ **FIXED - Blocking 2:** Single unnamed tuple components not exposed
- aave-v4's getUserAccountData documents `result.healthFactor` but wasn't advertising it
- Now advertises `result.<componentName>` for unnamed tuple components

### Current Status:
- All fixes applied in 9b0ddba96
- 5 protocol-output-fields tests passing
- 20 aave-v4 tests passing
- **Awaiting re-review from suisuss and joelorzet**

---

## PR #2441: fix: split L2 contracts to prevent advertising unimplemented functions
**URL:** https://github.com/KeeperHub/keeperhub/pull/2441
**Status:** CHANGES_REQUESTED (suisuss)
**Last Update:** Fixed in commit 857a9c086

### Issues Reported:
✅ **FIXED - Blocking:** Shared ABI constant pollution
- `ERC20_READONLY_ABI` was shared between `sky` governance token and new `sUsdsL2`
- Adding `totalSupply` to the shared constant accidentally added unreviewed action to `sky`
- Now split into two constants:
  - `ERC20_READONLY_ABI` (balanceOf only) for sky
  - `ERC20_READONLY_WITH_SUPPLY_ABI` (balanceOf + totalSupply) for sUsdsL2

✅ **FIXED - Mechanical:** Added test case asserting `sky` contract exposes only `get-sky-balance`

### Current Status:
- All fixes applied in 857a9c086
- 46 actions (was 47), 33 read actions (was 34)
- All 17 tests passing
- **Awaiting re-review from suisuss**

---

## PR #2469: feat: wire trace matcher into event tracker (tracker slice)
**URL:** https://github.com/KeeperHub/keeperhub/pull/2469
**Status:** CHANGES_REQUESTED (joelorzet)

### Issues Reported:
❌ **BLOCKING 1:** Staleness watchdog missing new subscriber type
- Location: `keeperhub-events/event-tracker/src/chains/provider-manager.ts:1748`
- Current code only checks `entry.subscribers.size === 0`
- Should check all three subscriber types (logs, state, trace)
- A chain with only trace subscribers runs with live block listener but no staleness detection
- Note: PR #2468 makes same correction for `stateSubscribers`, coordinate which lands second

❌ **BLOCKING 2:** Issue inline on `.npmrc` (not detailed in review)

### Current Status:
- **Not yet addressed**
- CI passing (all checks SUCCESS or SKIPPED)
- Needs code changes before re-review

---

## PR #2468: fix: check both subscriber types in block-staleness watchdog
**URL:** https://github.com/KeeperHub/keeperhub/pull/2468
**Status:** CHANGES_REQUESTED (joelorzet)

### Issues Reported:
✅ **Verified Correct:** The main change is correct
- `subscribeToState` attaches block listener on first subscriber
- `detachIfIdle` already tested both sets
- This guard was the odd one out

❌ **BLOCKING:** Needs one more line
- "The remediation it unblocks is itself log-scoped"
- Specific line/location not detailed in review comment

### Current Status:
- **Partially complete** - main fix is correct but incomplete
- CI passing (all checks SUCCESS or SKIPPED)
- Needs one additional line before re-review

---

## Next Steps:

1. **PR #2440** - Re-request review (fixes complete)
2. **PR #2441** - Re-request review (fixes complete)
3. **PR #2469** - Fix staleness watchdog to check all three subscriber types + address `.npmrc` issue
4. **PR #2468** - Add the missing "one more line" for log-scoped remediation

## Notes:
- All PRs have CI passing (no actual CI failures despite user's report)
- Main blocker is addressing the change requests from reviewers
- PRs #2469 and #2468 are related (both touch subscriber type checking)
