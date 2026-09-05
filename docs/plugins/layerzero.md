---
title: "LayerZero"
description: "LayerZero V2 omnichain tokens (OFT) and endpoint configuration. Quote crosschain fees, inspect an OFT's peers and approval needs, and read the send library and DVN configuration a lane will use."
---

# LayerZero

LayerZero V2 moves a token between chains by locking or burning it on the source chain and releasing or minting it on the destination. The contract that does this is an OFT (Omnichain Fungible Token), or an OFT Adapter wrapped around an ERC-20 that already exists. From the outside it looks like one call. It is really four separate decisions, and each one fails in its own way.

The fee is quoted, not fixed. A crosschain send pays the LayerZero messaging fee up front in the source chain's native gas token, and that fee moves with destination gas prices, with the verifier set the lane uses, and with how much gas you ask the executor to spend on delivery. There is no constant to hard-code. The recipient is not an address either: the OFT takes a `bytes32`, so a plain 20-byte EVM address has to be left-padded before it goes on the wire. The executor options are an opaque encoded blob, not a number; an empty blob is rejected at the message library on any OFT that does not set enforced options of its own, so "leave it out" is not a safe default. And the approval step exists for some OFTs and not others: an Adapter that locks and unlocks an existing token pulls it with `transferFrom` and needs an ERC-20 allowance first, while an OFT that is itself the token does not.

Underneath all of that sits a security configuration you did not choose and can not see from the token contract. Every lane (a source chain plus a destination endpoint) is verified by a set of DVNs (Decentralized Verifier Networks, the parties that attest a message really happened) and delivered by an executor, with a confirmation count attached. An OApp owner can change that configuration at any time. Nothing in the send call tells you it changed. A transfer that used to require three independent verifiers can quietly start requiring one, and the transfer still succeeds.

## What goes wrong, and which read catches it

| What you see | What actually happened | The read that catches it first |
|--------------|------------------------|--------------------------------|
| The send reverts inside the message library | The options blob was empty and the OFT sets no enforced options, so the executor was given no gas budget for delivery | OFT Quote Send with the exact options you intend to send: it fails on the same input before you spend anything |
| The quoted fee is far higher than you budgeted | The OFT sets enforced options and yours are combined with them, so the executor sums the delivery gas from both | OFT Quote Send, quoted with your real options rather than an assumed floor |
| The send reverts on an ERC-20 transfer | The OFT is an Adapter that pulls the underlying token with `transferFrom`, and there is no allowance | OFT Approval Required, then OFT Check Allowance |
| Less arrives than you sent | Amounts below the OFT's shared decimals are removed as dust before the message is built | OFT Quote Transfer, specifically `oftReceipt.amountReceivedLD` |
| The send reverts as soon as it is submitted | The destination lane was never wired, so the peer registered for that endpoint ID is all zeros | OFT Peer |
| Nothing routes to that chain at all | The endpoint has no default send library or no default receive library for that endpoint ID | Endpoint Is Supported EID |
| The transfer works, but a different set of parties vouched for it | The OApp's send library or its DVN and confirmation configuration was changed | Endpoint Get Send Library and Endpoint Get Config, compared against a baseline you stored earlier |

The last row is the one that does not announce itself. The other failures are loud: something reverts, or a number is short. A verifier set that shrinks from three parties to one changes what the transfer is worth trusting, and every transfer afterwards still succeeds. The only way to notice is to read the configuration on a schedule and compare it with what it was.

## What this integration does today

Supported chains: Ethereum, Base, Arbitrum One, Optimism, Polygon, Ethereum Sepolia, Base Sepolia.

The OFT actions and the underlying-token actions take the contract address as an input, because there is no single OFT address the way there is a single lending pool: every omnichain token is its own deployment. The EndpointV2 actions do not, because LayerZero's endpoint has one known address per chain (`0x1a44076050125825900e736c501f859c50fE728c` on the mainnets listed above, `0x6EDCE65403992e310A62460808c4b910D972f10f` on both testnets), which is resolved from the chain you select.

Every read action works without credentials. The one write action, OFT Approve, needs a connected wallet.

Sending tokens is not yet supported from this integration. The actions below let a workflow quote a transfer, check the preconditions, and gate on them; the send itself is a later addition.

## Endpoint IDs

LayerZero addresses chains by its own identifier, the endpoint ID (EID). It is not the EVM chain ID, and the two are never interchangeable: Ethereum is chain 1 and endpoint 30101. Every action below that asks for a destination or remote chain wants the endpoint ID.

| Network | EVM chain ID | LayerZero endpoint ID |
|---------|--------------|-----------------------|
| Ethereum | 1 | 30101 |
| Optimism | 10 | 30111 |
| Polygon | 137 | 30109 |
| Base | 8453 | 30184 |
| Arbitrum One | 42161 | 30110 |
| Ethereum Sepolia | 11155111 | 40161 |
| Base Sepolia | 84532 | 40245 |

Mainnet endpoint IDs start at 30000 and testnet endpoint IDs at 40000. A destination outside this table still works as long as the endpoint supports it; check it with Endpoint Is Supported EID and look the identifier up on the [LayerZero deployed contracts page](https://docs.layerzero.network/v2/deployments/deployed-contracts).

## What a checked send looks like

None of the reads below is interesting on its own. What they are for is the sequence a workflow runs before it commits to a transfer, where each step rules out one of the failures above:

1. Endpoint Is Supported EID on the destination endpoint ID, to establish the endpoint can route there at all.
2. OFT Peer for the same endpoint ID, to establish this particular token has a counterpart wired there. A supported lane with no peer still reverts.
3. OFT Underlying Token to find the ERC-20 the OFT actually moves, then OFT Check Token Balance on it to confirm the sending wallet holds enough. This step is unconditional. It applies to every OFT, not just the ones needing an approval: a mint-and-burn contract burns tokens the sender has to hold exactly as a lock-and-unlock Adapter transfers them.
4. OFT Approval Required, to decide whether an approval step exists at all for this OFT. Only when it returns true: OFT Check Allowance to see whether the Adapter can already pull the amount, and OFT Approve when it cannot.
5. OFT Quote Transfer, to see the amount that will actually arrive after dust removal rather than the amount you asked for.
6. OFT Quote Send with the exact options you intend to use, to get the native fee the send will have to pay, and to fail early if the options are wrong.
7. Endpoint Get Send Library and Endpoint Get Config, compared against a stored baseline, to confirm the parties verifying the lane are still the ones you agreed to.

Steps one through six each end in a revert or a shortfall you would have found the hard way. Step seven does not: it is the check that catches a change nothing else reports.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| OFT Quote Send | Read | No | Quote the LayerZero messaging fee for a crosschain send |
| OFT Quote Transfer | Read | No | Preview the transfer limits, fee breakdown, and exact amount received |
| OFT Approval Required | Read | No | Whether this OFT needs an ERC-20 approval before sending |
| OFT Shared Decimals | Read | No | The decimal precision shared across every chain this OFT lives on |
| OFT Underlying Token | Read | No | The ERC-20 this OFT moves |
| OFT Peer | Read | No | The OFT address registered for a destination endpoint, as bytes32 |
| OFT Approve | Write | Wallet | Approve an OFT Adapter to pull the underlying token |
| OFT Check Token Balance | Read | No | Balance of the underlying token for an address |
| OFT Check Allowance | Read | No | How much of the underlying token an Adapter may pull from an owner |
| Endpoint Get Send Library | Read | No | The message library an OFT will send through for a destination |
| Endpoint Get Config | Read | No | The executor or DVN configuration an OFT uses on a library for a destination |
| Endpoint Is Supported EID | Read | No | Whether this endpoint can route to a destination endpoint ID at all |

---

## OFT Quote Send

Quote the LayerZero messaging fee for sending an OFT to another chain. The `nativeFee` output is denominated in wei of the source chain's gas token.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT / OFT Adapter Address |
| dstEid | uint32 | Destination Endpoint ID. The LayerZero endpoint ID of the destination chain, not its EVM chain ID |
| to | address | Recipient Address. Enter a standard EVM address; it is padded to the bytes32 the OFT expects |
| amountLD | uint256 | Amount (token smallest unit). The amount to send, in the token's local decimals |
| minAmountLD | uint256 | Minimum Amount (token smallest unit). The slippage floor, in the token's local decimals |
| extraOptions | bytes | Extra Options. Advanced. Defaults to `0x00030100110100000000000000000000000000030d40`, a Type 3 blob giving the executor 200,000 gas for delivery |
| composeMsg | bytes | Compose Message. Advanced. Defaults to `0x`. Bytes delivered to a composer contract on the destination |
| oftCmd | bytes | OFT Command. Advanced. Defaults to `0x`. Unused by the standard OFT |
| payInLzToken | bool | Pay In LZ Token. Advanced. Defaults to `false`, which quotes in the chain's native gas token |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| fee | tuple | Messaging Fee: `nativeFee` and `lzTokenFee`, each in its token's smallest unit |

The result is a pair, not a single number. Read the native side as `fee.nativeFee`: that is the amount in wei of the source chain's gas token, and it is what a send would have to attach as its value. `fee.lzTokenFee` is the same fee denominated in ZRO, and it is only non-zero when `payInLzToken` is true on an OFT that accepts ZRO payment.

Two things about `extraOptions` decide whether the number you get back is the number you will actually pay. First, the default is a working floor, not a no-op: an OFT that sets no enforced options rejects an empty blob outright, so 200,000 gas for delivery is the safe starting point for a plain token receive. Raise it when the receiving contract runs logic of its own. Second, on an OFT that does set enforced options, yours are combined with them rather than replacing them or being ignored. The executor sums the delivery gas across both, so an OFT enforcing 100,000 gas budgets 300,000 with this default, and the quote comes back correspondingly larger. Quote with the options you intend to send, not with a guess.

**When to use:** budgeting the native value a crosschain send will need, alerting when a lane's fee crosses a threshold, or gating a scheduled transfer on the fee being under a ceiling. It is also a partial rehearsal: the quote runs the same peer and options validation a send does, so a quote that reverts is a send that would have reverted. It does not look at your balance or your allowance, so it is not a complete one.

---

## OFT Quote Transfer

Preview an OFT transfer: the transfer limits, the fee breakdown, and the exact amounts debited and received after dust removal.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT / OFT Adapter Address |
| dstEid | uint32 | Destination Endpoint ID. The LayerZero endpoint ID of the destination chain, not its EVM chain ID |
| to | address | Recipient Address. Enter a standard EVM address; it is padded to the bytes32 the OFT expects |
| amountLD | uint256 | Amount (token smallest unit). The amount to send, in the token's local decimals |
| minAmountLD | uint256 | Minimum Amount (token smallest unit). The slippage floor, in the token's local decimals |
| extraOptions | bytes | Extra Options. Advanced. Defaults to `0x00030100110100000000000000000000000000030d40` |
| composeMsg | bytes | Compose Message. Advanced. Defaults to `0x` |
| oftCmd | bytes | OFT Command. Advanced. Defaults to `0x` |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| oftLimit | tuple | Transfer Limits: `minAmountLD` and `maxAmountLD` |
| oftFeeDetails | tuple[] | Fee Details. A list of `feeAmountLD` and `description` entries, empty when the OFT charges no transfer fee |
| oftReceipt | tuple | Receipt Preview: `amountSentLD` and `amountReceivedLD` |

This is the action that answers "how much actually arrives". `oftReceipt.amountSentLD` is the amount actually debited once dust below the OFT's shared decimals has been removed, so it can already be smaller than the amount you typed. `oftReceipt.amountReceivedLD` is what gets credited on the destination after any fee the OFT charges on top of that. Note the split of responsibilities: this action tells you about the tokens, OFT Quote Send tells you about the messaging fee. Neither one covers the other.

`minAmountLD` is a floor both this quote and a real send enforce. Set it equal to the amount and a single unit of dust removal is enough to make the call revert, so leave headroom.

**When to use:** confirming the exact amount a recipient will be credited before committing to a transfer, checking a size against the lane's limits, and catching an OFT whose own fee schedule changed.

---

## OFT Approval Required

Whether this OFT needs an ERC-20 approval before sending.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT / OFT Adapter Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| approvalRequired | bool | Approval Required |

`true` means the contract pulls the underlying token with `transferFrom`, so an approval has to be in place before a send. `false` means it does not.

Decide the approval step from this value and nothing else. In particular, do not infer it from the underlying token address being different from the OFT's own address. A Mint and Burn OFT Adapter is a separate contract that holds mint and burn rights over a token that already exists: it has a distinct token address and it still reports `false`, because it never pulls anything. Reading the two addresses and comparing them gives the wrong answer for that whole class of deployment, and gives it silently.

**When to use:** as the branch that decides whether a workflow runs OFT Approve at all, and as a guard when the same workflow is pointed at OFTs of different styles.

---

## OFT Shared Decimals

The decimal precision shared across every chain this OFT lives on. Amounts below this precision are removed as dust before sending.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT / OFT Adapter Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| sharedDecimals | uint8 | Shared Decimals |

An OFT can have different local decimals on different chains, so it agrees on one lower precision to carry across the wire. Six is common. Anything finer than that in the amount you send is dropped, which is where the gap between the amount you typed and `oftReceipt.amountSentLD` comes from.

**When to use:** computing a send amount that survives dust removal intact, and explaining a shortfall a user reports on the destination side.

---

## OFT Underlying Token

The ERC-20 this OFT moves.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT / OFT Adapter Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| token | address | Token Address |

The value is the OFT's own address when the OFT is itself the token. It is a separate contract for both adapter styles: the one that locks and unlocks a token it holds, and the one that mints and burns a token it has rights over. Because both styles return a separate address and only one of them needs an allowance, a differing address does not mean an approval is needed. Use OFT Approval Required for that.

**When to use:** finding the token contract to point OFT Check Token Balance, OFT Check Allowance and OFT Approve at, when all you have is the OFT address.

---

## OFT Peer

The OFT address registered on a destination chain, as bytes32.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT / OFT Adapter Address |
| eid | uint32 | Destination Endpoint ID. The LayerZero endpoint ID of the destination chain, not its EVM chain ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| peer | bytes32 | Peer (bytes32) |

All zeros means the lane is not wired: this OFT has no counterpart registered for that endpoint ID, and a send to it reverts. A non-zero value is the destination contract left-padded to 32 bytes, so an EVM counterpart shows up as twelve zero bytes followed by its twenty-byte address.

**When to use:** confirming a lane exists before a workflow offers it, and detecting a peer being changed or unset by the OApp owner.

---

## OFT Approve

Approve an OFT Adapter to pull the underlying token. Needed only when OFT Approval Required returns true.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT Underlying Token (ERC-20) Address |
| spender | address | Spender (OFT Adapter). The address that will call `transferFrom` on this token during a send |
| amount | uint256 | Amount (token smallest unit). The allowance to grant. Must cover the amount you intend to send |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| result | bool | Result |

Note which contract this runs against: the approval is granted on the token, not on the OFT, so `contractAddress` is the underlying token address from OFT Underlying Token, and `spender` is the OFT Adapter.

This is the only write action in the integration, and it needs a connected wallet.

When the underlying token is one the platform recognises as a stablecoin (USDT and USDC, which covers the USDT0 family), this approval is bounded by the same 100 USD per-transaction stablecoin limit that applies to a stablecoin transfer. Approvals above that limit are allowed only when the spender is a contract address the platform already knows, and an OFT Adapter is an address you type in rather than one the platform holds, so that exemption never applies here. Approve the amount each transfer needs instead of a large standing allowance; the limit itself is a deployment-wide setting, not something an organization can raise from its own spending limits, and [Direct Execution](/api/direct-execution) covers how a self-hosted deployment changes it.

**When to use:** the step before a crosschain send on a lock-and-unlock Adapter, approving the amount that send needs. Follow it with OFT Check Allowance to confirm it took effect.

---

## OFT Check Token Balance

Balance of the underlying token for an address. Use before a send to catch an empty wallet early.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT Underlying Token (ERC-20) Address |
| account | address | Account Address. The address whose token balance to read |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Token Balance (smallest unit) |

**When to use:** gating a scheduled transfer on the funding wallet actually holding the tokens, and alerting when a treasury balance on one chain falls below the level a rebalance needs.

---

## OFT Check Allowance

How much of the underlying token an OFT Adapter may pull from an owner. Use to confirm the approve step took effect.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | OFT Underlying Token (ERC-20) Address |
| owner | address | Token Owner. The address that granted the approval |
| spender | address | Spender (OFT Adapter) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| allowance | uint256 | Allowance (smallest unit) |

**When to use:** verifying an approval landed before depending on it, and re-checking a standing allowance that earlier sends have drawn down.

---

## Endpoint Get Send Library

The message library an OFT will send through for a destination. Resolves to the LayerZero default when the OFT has not chosen one.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| sender | address | OFT Address. The OFT, or any OApp, whose send library to look up |
| dstEid | uint32 | Destination Endpoint ID. The LayerZero endpoint ID of the destination chain, not its EVM chain ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| sendLibrary | address | Send Library Address |

The send library is the contract that encodes and pays for the message on the way out, and it is where the DVN and executor configuration is stored. This action does not tell you whether the OApp picked that library itself or fell back to the chain default; both cases return an address. What it gives you is the address the next action needs.

Runs against LayerZero's endpoint on the chain you select, so it takes no contract address of its own.

**When to use:** as the first half of a configuration check: read the library here, then pass it to Endpoint Get Config. On its own, a change in the returned address is already a signal worth alerting on.

---

## Endpoint Get Config

The ABI-encoded configuration an OFT uses on a library for a destination.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| oapp | address | OFT Address. The OFT, or any OApp, whose configuration to read |
| lib | address | Message Library Address. The send or receive library to read from. Use the Endpoint Get Send Library output for the send side |
| eid | uint32 | Remote Endpoint ID. The LayerZero endpoint ID of the remote chain, not its EVM chain ID |
| configType | uint32 | Config Type. Defaults to `2` |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| config | bytes | Config (ABI-encoded bytes) |

Two config types matter. Type `1` returns the executor configuration: the maximum message size and the executor address. Type `2` returns the ULN configuration: the confirmation count, the required DVNs and the optional DVNs with their threshold. Type `2` is the default because it is the one that describes who has to vouch for a message before it is delivered.

The output is raw ABI-encoded bytes, not a decoded struct. That is awkward to read and exactly right for the job this action is for: store the bytes once as a baseline, then compare later reads against them. Any change to the DVN set, the threshold or the confirmation count changes the bytes, so a plain equality check on an opaque value is a complete change detector without needing to decode anything.

Runs against LayerZero's endpoint on the chain you select, so it takes no contract address of its own.

**When to use:** a scheduled trust check on a lane your workflows depend on. Read the send library, read its type `2` configuration, compare with the stored baseline, and alert when the bytes differ. This is the failure that produces no revert and no short balance, so nothing else surfaces it.

---

## Endpoint Is Supported EID

Whether this endpoint supports the destination endpoint ID.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| eid | uint32 | Destination Endpoint ID. The LayerZero endpoint ID of the destination chain, not its EVM chain ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| supported | bool | Supported |

It returns `true` only when both the default send library and the default receive library are set for that endpoint ID, meaning messages can be routed there at all. One direction configured is not enough.

Be clear about what this does and does not cover. It is a statement about the endpoint, not about your token: a lane can be supported by the endpoint while the OFT has no peer registered on it. Pair this with OFT Peer to answer both halves of "can I send there".

Runs against LayerZero's endpoint on the chain you select, so it takes no contract address of its own.

**When to use:** validating an endpoint ID a user typed before anything else runs, and confirming a newly announced chain is actually routable from the chain you are on.

---

## Testing Without Risking Real Funds

Every action except OFT Approve is a read, so the safe way to exercise them is against a live mainnet OFT: reads cost nothing and change nothing. For OFT Approve, and for driving the whole sequence end to end, use a local mainnet fork.

### A public deployment to read against

The USDT0 OFT Adapter on Ethereum is a good target because it is the case that needs an approval: an Adapter that locks and unlocks an existing token rather than an OFT that is itself the token. It lives at `0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee` and wraps USDT at `0xdAC17F958D2ee523a2206206994597C13D831ec7`.

Point the OFT actions at the Adapter address and the token actions at the USDT address. OFT Approval Required returns `true` there, which makes it one of the deployments where the approve step is genuinely needed, and OFT Shared Decimals returns `6`. For the endpoint actions, pass the Adapter as the OFT address and a destination endpoint ID from the table above.

### Running a fork

In one terminal, start anvil against your mainnet RPC:

```bash
docker run --rm -p 8545:8545 ghcr.io/foundry-rs/foundry:v1.7.1 \
  "anvil --host 0.0.0.0 --fork-url <YOUR_MAINNET_RPC_URL>"
```

Pin an explicit version rather than using `latest` or `stable`. On GHCR, `latest`
is foundry's nightly build, which changes daily and has shipped versions of anvil
that cannot fork some chains at all; `stable` is unmaintained and lags well behind
the newest release.

Then point your local dev server at the same fork by overriding the Ethereum mainnet RPC URL:

```bash
CHAIN_ETH_MAINNET_PRIMARY_RPC=http://localhost:8545 pnpm dev
```

Any wallet you connect has to be funded on the fork. Use one of anvil's pre-funded private keys for gas, and to get USDT into it, impersonate a large holder with `anvil_impersonateAccount` and transfer some across; that is enough to run OFT Approve and then watch OFT Check Allowance change. Workflows targeting chain ID 1 will hit the forked bytecode instead of real mainnet.

### A testnet pair

If you would rather stay on a public testnet than run a fork, there is a USDT+ test-token pair on Base Sepolia at `0xdE287B4a0918102511b027d53688c169fb308762`, wired via `peers()` to a counterpart on Ethereum Sepolia at `0xe20534a32f9162488a90026F268a74fBE28d272D`. On that pair the OFT is itself the token, so OFT Underlying Token returns the same address you passed in and OFT Approval Required returns `false`.

Treat it for what it is: a community test token deployed by a third party, not an official LayerZero or Tether deployment. It can be changed, re-pointed or abandoned without notice, so it is fine for exercising the actions and wrong as a reference for how a production deployment behaves.
