---
title: "Run Error Codes"
description: "What the error codes on a failed workflow run mean and what to do about them."
---

# Run Error Codes

When a run fails for a reason on KeeperHub's side -- rather than a problem with
your workflow's configuration -- the run logs show a short message with a code
in the form `PREFIX-NNNN`, for example `P-0001`. The code identifies the kind of
problem so support can help quickly if it persists.

Configuration mistakes in your own workflow -- an invalid address, a missing
template variable, a contract call that reverted -- are shown with their full,
actionable message instead of a code. Fix the highlighted step and run again.

## What the codes mean

Almost every coded error is temporary. Unless noted below, the action is the
same: wait a few minutes and try the run again.

| Code | What happened | What to do |
| ---- | ------------- | ---------- |
| `E-0001` | The run timed out. | Try again. |
| `E-0002` | A step failed after repeated attempts. | Try again; if it keeps failing, review that step. |
| `E-0003` | The run hit an internal processing error. | Wait a few minutes and try again. |
| `E-0004` | The run could not be processed. | Wait a few minutes and try again. |
| `N-0001` | A blockchain network provider was temporarily unavailable. | Try again shortly. |
| `N-0002` | A temporary network error interrupted the run. | Wait a few minutes and try again. |
| `P-0001`, `P-0002`, `P-0004`, `P-0005` | The run could not be started. | Try again. |
| `P-0003` | The run stopped unexpectedly. | Try again. |
| `C-0001`, `C-0002` | A temporary internal error. | Wait a few minutes and try again. |
| `C-0003`, `C-0004` | An internal problem on our side. | Our team is notified automatically. Contact support if it keeps happening. |
| `CS-0001`, `BS-0001`, `ES-0001` | A scheduled, block, or event trigger could not be started this time. | These retry automatically -- no action needed. |

If a coded error keeps happening for the same workflow, contact support and
include the code and the time of the run.
