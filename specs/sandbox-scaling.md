# Code Sandbox Scaling Notes

Plain-language summary for deciding how to scale the code sandbox. The sandbox
runs users' Code-node JavaScript, each run in its own short-lived process.

## The problem

Clients sometimes get a "rate limit" (429) error from Code nodes. That happens
because the sandbox only allows a fixed number of code runs at the same time,
and once that number is hit, extra runs are rejected.

Today the limit is 16 runs at once across all of prod (8 per pod, 2 pods). A
normal paid workload can trip that on a brief spike, which is too low.

## Why the limit is 16 and not higher

Each running pod has half a CPU core and 512MB of memory. Each code run is a
full Node process that needs CPU to start up and some memory to run.

- CPU is the real ceiling: half a core can only handle about 8 runs at once
  before they start fighting for CPU and slow down.
- Memory is the hidden risk: 8 runs already use most of the 512MB. A heavy run
  can push a pod over its memory limit, which crashes the pod and kills every
  run on it at once.

So the 16 is not arbitrary. Just raising the number without giving the pods more
CPU and memory makes runs slow and crash instead of fixing anything.

## The options

| Option | What it does | Cost | Trade-off |
| --- | --- | --- | --- |
| Retry on 429 | Client waits a moment and retries instead of erroring | Free | Hides short spikes. Does not add real capacity. Shipping now. |
| Bigger pods, "best effort" | Allow pods to use more CPU/memory if the machine has it free | Roughly free | Faster only when the machine is not busy. Unreliable under load. |
| Bigger pods, "reserved" | Permanently reserve more CPU/memory per pod | About +45 to +90 / month | Reliable, but you pay for it 24/7 even when the sandbox is idle. Still a fixed ceiling. |
| Autoscaling | Start with 2 pods, add more automatically during busy periods, remove them when quiet | Pay only for what you use | The best fit. Needs a bit more setup. |

## What we shipped now

The retry. When the sandbox says "I'm full, try again in a moment," the client
now waits and retries (up to 3 times) instead of failing. This is free and
removes most of the errors clients see, because most of them are tiny spikes
that pass in under a second. It does not add capacity on its own.

## What to do next (recommended)

1. Keep the pods their current size.
2. Turn on autoscaling: always keep 2 pods running, and automatically add more
   when the sandbox gets busy, then scale back down when it quiets.
3. Bump the per-pod memory limit from 512MB to 1GB (this part is free) so a
   single heavy run can no longer crash a pod.

This matches cost to actual usage: cheap when idle, more capacity exactly when
clients need it, and no fixed wall that a busy day can hit.

## One number to confirm first

Before picking how many pods to allow at the busiest point, pull the real
numbers from monitoring: how many code runs actually happen at once on a busy
day, and how often the 429 is currently firing. The plan above is sound, but the
exact "max pods" should be set from that data, not a guess.
