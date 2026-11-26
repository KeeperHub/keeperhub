---
title: "RPC Endpoints"
description: "Run your organization's on-chain traffic through your own RPC providers."
---

# RPC Endpoints

By default, KeeperHub reads from and writes to every supported chain through its own RPC providers. Your organization can add its own RPC endpoints instead, so that workflow steps, direct executions and triggers use the providers you choose.

Owners and admins manage endpoints in **Settings > RPC endpoints**. Every member can see the configured endpoints and pick them on workflow steps.

## RPC configs

An RPC config holds the endpoints for one chain:

| Endpoint | Used for |
| --- | --- |
| HTTPS primary (required) | Reads and transactions |
| HTTPS fallback | Used when the primary fails |
| WSS primary | Event and block triggers |
| WSS fallback | Used when the WSS primary fails |
| Private transaction URL | Steps that send through a private mempool |

Solana configs take an HTTPS primary and an HTTPS fallback.

Paste each URL in full, including the API key if your provider puts it in the URL. URLs are stored encrypted and are never shown again after you save them, not even in part: a saved config shows only which URLs are set and whether each passed its check. Give each config a name that tells it apart from the others. To change a URL, paste the new one in full.

### Checks before saving

Before a config is saved, KeeperHub calls each URL and confirms that:

- the host is reachable on the public internet
- the endpoint answers for the chain you selected (by chain ID on EVM chains, by genesis hash on Solana)

A URL that fails a check is not saved, and the reason is shown next to it. Use **Test connection** on a saved config to run the checks again.

### Default config per chain

You can add several configs for the same chain, for example one for everyday use and one for archive reads. One config per chain can be the default, and steps set to **Auto** use it. The first config you add for a chain becomes its default automatically.

You can also remove the default, or disable the config that holds it. KeeperHub asks you to confirm first, because steps and triggers on that chain set to **Auto** then run on KeeperHub's endpoints. On a chain that uses your endpoints only, they have no endpoint left, so the change is refused while a workflow depends on them.

## Choosing endpoints on a step

Steps and triggers that call a chain have an **RPC endpoint** option under **Advanced**:

- **Auto** uses your organization's default config for the step's network, or KeeperHub's endpoints when the chain has none.
- **KeeperHub default** always uses KeeperHub's endpoints.
- A specific config uses that config's endpoints.

When a step's endpoints fail, it moves to the fallback endpoint. If a config has no fallback, KeeperHub's endpoint is used as the fallback, unless the chain uses your endpoints only.

## Your endpoints only

By default, KeeperHub's endpoints are the backup: if your endpoints fail, or cannot serve a call (for example a trigger that needs a WSS endpoint), KeeperHub's endpoints take over.

**Your endpoints only** turns that backup off for one chain. Open the chain in **Settings > RPC endpoints** and turn it on to make sure KeeperHub never uses its own RPC providers on that chain for your organization. If your endpoints fail, the step fails instead. Other chains keep KeeperHub as their backup. On a chain with it on:

- every step and trigger uses your configs, and a config's fallback is only the fallback you set
- **KeeperHub default** is not available on steps for that network
- the private mempool option is available only where your config has a private transaction URL

You can turn it on for a chain once every workflow step and trigger on that chain has a config that can serve it. Event and block triggers also need a WSS endpoint. If something is missing, the settings page lists the workflows and steps that need a config first. While it is on, saving a workflow step on that chain without a config, or removing a config that a workflow depends on, is refused with the affected steps listed.

## Usage and transparency

The **Analytics** page has an **RPC usage** section that shows, for the selected time range:

- requests sent through your endpoints and through KeeperHub's
- errors, timeouts, rate-limit responses and fallbacks
- average and highest response time
- a breakdown by config and chain

For each chain that uses your endpoints only, the section confirms how many requests on that chain went through KeeperHub's providers in the range. Each run's step details also show which endpoint served the step and whether it moved to a fallback.

Usage on your endpoints is recorded for your organization only. KeeperHub's own monitoring does not collect logs or metrics about them.
