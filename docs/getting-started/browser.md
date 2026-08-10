---
title: "Browser"
description: "Build and run your first KeeperHub workflow in the visual builder at app.keeperhub.com."
---

# Getting Started in the Browser

Build a workflow on the canvas, run it, and read the result. About ten minutes.

## 1. Create an account

Sign up at [app.keeperhub.com](https://app.keeperhub.com) with your email address and verify it
with the code you are sent.

A Turnkey wallet is provisioned for your organization automatically. While that is in flight the
workflow toolbar shows **Setting up wallet**; once it completes the toolbar shows your wallet
address. Click the address to open the wallet panel, or the copy icon beside it to copy the
address for funding.

You do not need to fund anything yet. Your organization gets a monthly allowance of sponsored gas
on mainnet, and read-only workflows never need a balance. Fund the wallet when you are ready to
move value, or switch to a testnet to experiment. See [Gas Management](/wallet-management/gas).

## 2. Open a new workflow

Click **New Workflow** in the left navigation sidebar. This opens the visual builder: a canvas
where you connect nodes into an automation.

There are three kinds of node:

- **Trigger** starts the workflow. Every workflow has exactly one.
- **Action** does the work: reads a balance, calls a contract, sends a message.
- **Condition** evaluates a value from an earlier node and branches on the result.

## 3. Choose a trigger

Click the trigger node to open its configuration panel on the right, then pick a **Trigger Type**:

| Trigger | Fires |
|---|---|
| Manual | When you click Run in the builder |
| Schedule | On a recurring schedule |
| Webhook | When an external service posts to your workflow URL |
| Event | When a contract emits a matching event |
| Block | At a block interval on a chosen chain |
| Transfer | When a payment arrives at a watched address |

Start with **Manual**. You can switch to an automated trigger once the workflow does what you want.

## 4. Add an action

Add a step to the canvas with **Add Step**, or right-click the canvas and choose it from the
context menu. This opens the action grid, grouped by integration.

For a first workflow, pick **Web3** and then **Get Native Token Balance**. It reads the native
balance of any address and needs no wallet, no funds, and no connection.

Click the node to configure it. This action takes two fields:

- **Network** - the chain to read from
- **Address** - the address whose balance you want

Write actions such as **Transfer Native Token** or **Write Contract** additionally require a
wallet connection. Read actions do not.

## 5. Send yourself the result

To notify rather than just read, add a second action and connect it after the first.

Notification actions need a connection configured first. Click your avatar in the top right, then
**Connections**, and add the channel you want:

| Channel | Action |
|---|---|
| Discord | Send Discord Message |
| Slack | Send Slack Message |
| Telegram | Send Telegram Message |
| Email | Send Email |

Back on the canvas, configure the notification node and reference the balance from the previous
step in the message body. See [Templating Reference](/workflows/templating) for the syntax.

## 6. Run it

Click the green **Run** button in the workflow toolbar. KeeperHub checks the workflow, then
executes it.

Watch the run in the [Runs panel](/keeper-runs/overview): each node reports its status, output,
and any error, and onchain writes report their transaction hash.

## 7. Enable it

A manual workflow only runs when you click Run. To let it run on its own, switch the trigger to
Schedule, Webhook, Event, Block, or Transfer, then turn on the **Enable** switch in the toolbar.

That switch is workflow-level and is what activates automated execution. It appears only for
those five trigger types, because a Manual workflow has nothing to enable. Individual nodes can be
disabled separately, but disabling a node does not stop the workflow, and enabling every node does
not start it.

## Building with AI instead

Describe what you want in the **Ask AI...** prompt at the bottom of the canvas and the assistant
scaffolds the workflow for you to review before enabling:

- "Monitor my wallet and alert me on Discord if the balance drops below 0.5 ETH"
- "Check a contract function every hour and email me the result"

The **Getting started** panel, under your avatar, offers guided paths for connecting an agent,
setting up monitoring, or automating a yield strategy, with a walkthrough of the builder.

## Next

- [Creating Workflows](/workflows/creating) for conditions, loops, and multi-step logic
- [Hub](/workflows/hub) to start from a workflow someone else has published
- [Security Best Practices](/practices/security) before you point a workflow at mainnet
- Driving this from code instead? See [Agent](/getting-started/agent),
  [API](/getting-started/api), or [CLI](/getting-started/cli)
