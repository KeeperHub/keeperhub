# The Bybit Attack Was Caught by the Wrong People

**A $1.4 billion hack that a single automation would have flagged -- and why manual review is the vulnerability, not the solution.**

---

On February 21, 2025, the Lazarus Group stole $1.4 billion from Bybit's Safe multisig wallet. The signers checked the transaction. They reviewed it in the Safe UI. They approved it. They did everything right.

The problem: the Safe UI was the attack. The attackers had compromised a Safe developer's laptop weeks earlier, injected malicious JavaScript into the web application, and swapped the transaction data underneath the interface. The signers saw a routine transfer. What they actually signed was a `delegatecall` to a malicious contract that rewrote the wallet's implementation pointer and handed the attacker full control.

Every signer looked at the screen. Every signer approved. The manual review process didn't fail -- it was the attack surface.

---

## What actually happened, step by step

A Safe multisig works like this: someone proposes a transaction, it sits in a queue, owners review and sign it one by one, and once enough signatures are collected (the threshold), it executes on-chain.

Every transaction has an `operation` field. It's either `0` (a normal call -- "send ETH to this address" or "call this function on this contract") or `1` (a delegatecall -- "run this contract's code as if it were me, with full access to my storage").

A delegatecall from a Safe is almost never legitimate in day-to-day operations. It lets the target contract rewrite anything inside the Safe -- the owner list, the threshold, the implementation pointer, everything. It's the nuclear option.

The Bybit attack worked in three stages:

1. **Compromise the UI.** The attackers got access to a Safe developer's machine and injected JavaScript into the Safe web app. The code detected when Bybit's specific signers were using the app and only activated for them.

2. **Swap the transaction.** When a routine transaction was proposed, the malicious JavaScript replaced the actual parameters: it changed `operation` from `0` (call) to `1` (delegatecall), pointed `to` at the attacker's contract, and replaced the `data` field with malicious calldata. The UI continued to show the original, legitimate transaction.

3. **Collect signatures.** The signers opened Safe, saw what looked normal, and signed. Their hardware wallets showed the real EIP-712 data -- but as raw hex that most humans can't parse. Once enough signatures were collected, the transaction executed: a delegatecall to the attacker's contract, which overwrote the Safe's implementation pointer and gave the attacker arbitrary control over $1.4 billion in assets.

The manual review was perfect. The signers were diligent. The attack succeeded because the review happened inside the compromised environment.

---

## The tools that appeared after Bybit -- and what they miss

Since the hack, a wave of products has launched to address multisig security. Tenderly deepened its Safe simulation integration, letting signers preview state changes before approving. Blockaid shipped Cosigner, an automated co-signer that screens raw transaction data against a threat engine before adding its signature. Hypernative Guardian analyzes transaction intent before signing. CoolWallet added transaction simulation previews to their hardware wallets. Every major security vendor published a "how we would have stopped Bybit" blog post.

These are good products. Some of them would have caught the Bybit attack. But they all share the same blind spot: they assume a human is sitting at a desk, about to sign a transaction, with the time and context to review a simulation result or wait for a co-signer to approve.

That's not how DeFi operations actually work.

**The day-to-day reality of DeFi engineering:** A protocol team managing a Safe treasury isn't ceremonially reviewing one transaction per day in a war room. They're processing dozens of transactions per week -- payroll, grant disbursements, liquidity provisioning, parameter updates, contract deployments. The signers are spread across time zones. They sign asynchronously, often on mobile, often between other tasks. The idea that every signer will carefully review a Tenderly simulation or wait for Blockaid Cosigner to clear each transaction assumes a level of operational discipline that doesn't survive contact with a real team running a real protocol.

Context switching is the enemy. Going from your task to the Safe UI to a simulation tool to a verification result and back is friction. Friction gets skipped. The 50th transaction gets less scrutiny than the 1st. And the attacker only needs to win once.

**The near-future reality of autonomous agents:** This problem gets worse, not better. Coinbase has shipped Agentic Wallets. Protocols are building AI agents that manage DeFi positions, execute trades, and rebalance portfolios autonomously. These agents don't open the Safe UI. They don't review Tenderly simulations. They sign programmatically. If an agent's execution environment is compromised -- or if a malicious transaction lands in the queue from an external source -- no human is in the loop to catch it. A simulation tool that requires a human to look at it is useless when the signer isn't human.

The tools that launched post-Bybit solve the *verification* problem. They give you better ways to inspect a transaction before you sign it. But they don't solve the *monitoring* problem: who is watching the transaction queue when nobody is looking? Who alerts the team when a delegatecall appears at 3am on a Saturday? Who catches the anomaly when an autonomous agent is about to execute something it shouldn't?

What's missing is not a better verification step. It's a background process that watches continuously and pushes alerts through an independent channel -- before anyone signs, before anyone opens the UI, whether the signer is a human or an agent.

---

## The automation that would have caught it

There is a single piece of data that exposes this attack: the `operation` field in the pending transaction.

The Safe Transaction Service -- the off-chain API where pending transactions sit before they're signed -- stores the raw transaction data independently from the web UI. It doesn't go through the compromised JavaScript. It doesn't render anything for a human to misread. It just holds the data.

An automation that polls the Safe Transaction Service, reads the `operation` field, and sends an alert through an independent channel (Discord, Slack, email, PagerDuty -- anything that isn't the Safe UI) would have caught the Bybit attack before the first signer approved.

The alert would have arrived in Discord:

```
CRITICAL: Pending transaction uses delegatecall

Safe: 0x...Bybit
To: 0x96221423681A6d52E184D440a8eFCEbB105C7242
Operation: DELEGATECALL
Risk: 94/100

Analysis: This transaction executes a delegatecall to an unverified
contract. The target contract can modify any storage slot in the Safe,
including the implementation pointer. Do NOT sign unless you fully
understand and trust the target contract.

Signatures: 0/3
safeTxHash: 0x...
```

The signers would have seen this in Discord *before* they opened the Safe UI. Before the compromised JavaScript had a chance to show them a fake transaction. Before they touched their hardware wallets.

The question isn't whether a human *can* check the operation field. They can. The question is whether they're checking it through a channel the attacker doesn't control.

---

## Why automation, not better tools

The instinct is to say "just check the transaction more carefully." There are tools that decode calldata. There are block explorers. A sophisticated signer could parse the EIP-712 data on their hardware wallet. And now there are AI agents -- give one a calldata-decoding skill, point it at your Safe, and ask it to verify before you sign.

But this misses the point of the Bybit attack. The attack didn't exploit a lack of tools. It exploited the gap between having a tool and using it. Every signer had the ability to verify the transaction independently. None of them did, because the compromised UI gave them no reason to.

Better tools -- including AI agents -- don't close this gap. They widen the toolkit but leave the same vulnerability intact: **someone has to initiate the check.** An agent with a `verify-safe-tx` skill is powerful. But it's still a tool you reach for. The question isn't whether the tool is good. It's whether you'll reach for it every single time, including the time the attacker is counting on you not to.

The Bybit attack waited weeks after initial compromise to activate. It was patient. It was waiting for the 51st transaction, the one where the signer glances at the screen and approves without a second thought. A better tool doesn't help if nobody picks it up.

What changes the equation is not a smarter check. It's removing the human from the initiation loop entirely.

**1. Event-driven, not human-initiated.**

An agent with a `verify-safe-tx` skill is useful. But someone has to invoke it. What our workflow does is invoke that same check on a schedule -- every minute, automatically, whether anyone is at their desk or not. The moment a new transaction hits the Safe queue, the alert fires before any signer opens the app, before the compromised UI has a chance to show them anything. There is no step where a human decides "I should check this one." The check is the default. Silence is the anomaly.

**2. Independent source, independent channel.**

The automation queries the Safe Transaction Service API directly. It never loads the Safe web app. It never runs the compromised JavaScript. It sees the raw transaction data -- `operation: 1`, `to: 0xAttacker`, `data: 0xmalicious` -- and sends the result to Discord, Slack, or PagerDuty. Not to the Safe app. The signer sees two conflicting signals: the Safe UI says "routine transfer," Discord says "CRITICAL: delegatecall to unverified contract." That contradiction is the moment the attack falls apart.

**3. Infrastructure, not a session.**

An agent is a conversation. It starts, it helps, it ends. A workflow is infrastructure. It runs at 3am on a Saturday when the team is asleep and someone proposes a transaction. It runs on the ten thousandth transaction with the same rigor as the first. It doesn't get comfortable, doesn't get fatigued, doesn't skip the check because the last 50 were routine. The checking logic can be as sophisticated as you want -- what matters is that it runs without being asked, on infrastructure that outlasts any single session.

---

## How it works on KeeperHub

This is a production workflow running today on KeeperHub. Here's exactly what it does:

```
Every 1 minute (scheduled):

1. Poll Safe Transaction Service for pending transactions
2. Check: any new transactions since last poll?
3. For each new transaction:
   a. Check deduplication database (skip if already alerted)
   b. Decode the calldata and analyze the operation type
   c. Run AI risk assessment -- score 0-100, plain-English explanation
   d. Send Discord alert with:
      - Risk level and score
      - Decoded function name and parameters
      - Operation type (CALL vs DELEGATECALL)
      - Target address and value
      - Current signature count vs threshold
      - safeTxHash for independent verification
   e. Record in database (never alert on the same tx twice)
```

The alerts arrive in your team's Discord before anyone opens the Safe UI. Infrastructure engineers have a name for this pattern: running in the background. The low-risk alerts are ambient. "LOW (12/100) -- ERC-20 transfer of 500 USDC to known payroll address." You see it in your Discord feed, you glance at it, you move on. It's a heartbeat. It tells you the system is watching without demanding your attention.

The high-risk alerts are different. "CRITICAL (94/100) -- delegatecall to unverified contract, target can modify Safe storage." That one doesn't stay in Discord. It escalates to PagerDuty. It wakes someone up. It pages the on-call signer at 3am if it has to, because a delegatecall to an unverified contract is not something that should wait until morning.

Same workflow, two modes: background monitoring that builds passive awareness, and active escalation that interrupts you when it matters. The routine transactions build your team's intuition for what normal looks like. The critical ones make sure nobody signs before the team has seen the real data.

---

## Why no one else does this

Existing security tools operate in two modes, and neither covers this gap:

**Post-execution monitoring** (Etherscan, Nansen, Forta, OpenZeppelin Defender) watches on-chain events after transactions execute. By the time they alert you, the delegatecall has already fired, the implementation pointer is already overwritten, and the attacker already has control. These tools would have told Bybit they were hacked. They would not have prevented it.

**Pre-signing verification tools** (calldata decoders, simulation tools, Tenderly) require the signer to actively go use them. They're manual. They require context switching -- go to Safe, copy the calldata, go to another tool, paste it, read the output, go back to Safe. This is exactly the kind of workflow that erodes over time. And critically, if the signer is copying data from a compromised UI, they might be copying the fake data the attacker wants them to verify.

**What's missing is automated pre-signing monitoring through an independent channel.** Something that runs continuously, reads from the source API, and pushes alerts to you without you having to do anything. Not a tool you go to. A system that comes to you.

That's what this workflow is. It's not a better decoder. It's not a smarter block explorer. It's a background process that watches your Safe's transaction queue 24/7 and tells you, through Discord, what's actually in there -- before you sign, before you open the UI, before the attacker's deception has a chance to work.

---


## Deploy it now

The Safe Signing Alert workflow is live on KeeperHub as a public template:

1. Go to [app.keeperhub.io](https://app.keeperhub.io)
2. Find the Safe Signing Alert template
3. Enter your Safe address
4. Connect your Discord
5. Enable

It polls every minute. It deduplicates alerts. It decodes calldata and scores risk. It runs 24/7 without anyone remembering to check.

Your Safe is holding real value. The attacker is patient. Your automation should be running before they are.

---

**Sources:**

- [NCC Group: In-Depth Technical Analysis of the Bybit Hack](https://www.nccgroup.com/research-blog/in-depth-technical-analysis-of-the-bybit-hack/)
- [Sygnia: Investigation into the Bybit Hack](https://www.sygnia.co/blog/sygnia-investigation-bybit-hack/)
- [Check Point: What the Bybit Hack Means for Crypto Security](https://blog.checkpoint.com/security/what-the-bybit-hack-means-for-crypto-security-and-the-future-of-multisig-protection/)
- [Certora: The Bybit Hack and Multisig Wallet Security](https://www.certora.com/blog/bybit-hack-multisig-wallet-security)
- [Blockaid: How to Prevent the Next $1.5B Bybit Hack](https://www.blockaid.io/blog/how-to-prevent-the-next-15b-bybit-hack-a-strategic-approach-to-solving-blind-signing)
- [Hypernative: How Guardian Would Have Stopped the Bybit Hack](https://www.hypernative.io/blog/bybits-1-5b-hack-a-wake-up-call-for-crypto-security)
- [Coinbase: Introducing Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)
- [Chainalysis: 2025 Crypto Theft Reaches $3.4 Billion](https://www.chainalysis.com/blog/crypto-hacking-stolen-funds-2026/)
