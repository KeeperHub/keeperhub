---
title: "Notification Templates"
description: "Reference for all KeeperHub notification template formats across Discord, Slack, and Email."
---

# Notification Templates

This document provides standardized notification templates for KeeperHub operations. These templates are used across Discord, Slack, and Email notifications.

## Template Types

Notification templates depend on **Keeper Type** and **Trigger Type**:

### Keeper Types
- **Contract**: Smart contract interactions
- **Wallet**: Wallet monitoring and operations  
- **Multisig**: Multisig wallet monitoring

### Trigger Types
- **Manual**: User-triggered execution
- **Schedule**: Time-based scheduling
- **Webhook**: HTTP-triggered execution
- **Event**: Blockchain event-driven triggers
- **Block**: Block-cadence triggers

### Contract Keeper Templates
For Contract keepers, templates further depend on **Function Type**:

#### Read Functions
- **Contract Read Template**: For read-only function calls

#### Write Functions  
- **Contract Write Template (Success)**: For successful write transactions
- **Contract Write Template (Failure)**: For failed write transactions

### Event Trigger Templates
- **Event Template**: For Event detection (used across all keeper types when Event trigger is selected)

### Wallet & Multisig Keeper Templates
- **Balance Change Template**: For wallet balance monitoring
- **Threshold Template**: For threshold-based actions
- **Ownership Change Template**: For multisig ownership changes
- **Transaction Template**: For wallet/multisig transactions

---

## Contract Keeper with Read Function

    Timestamp: YYYY-MM-DD HH:MM:SS UTC
    Name: Keeper name
    Chain: Chain name
    Contract Address: Contract address
    Function Name: Function name
    Function Arguments: Function arguments listed as `key(input name): value` separated by a comma
    Function Output: Output of function returned as `key(output name): value` separated by a comma
    Conditions: List of conditions as `key(input name): value` separated by operator `and(&&)`, `or(||)`, `greater than(>)` or `less than(<)`
    Conditions Returns: `True` or `False`
    Notification Sent: Discord to `Discord channel name` (if sent), Slack to `Slack channel name`(if sent), email to `Email address`(if sent). If none then display `No notifications sent.`
    Transfer Sent: `transfer_amount` to `recipient_address`. If no transfer then display `No transfer sent`
    Webhook Sent: `webhook_name` (e.g. My Favourite Webhook). If no webhook sent then display `No webhook sent`

## Contract Keeper with Write Function (Success)

    Timestamp: YYYY-MM-DD HH:MM:SS UTC
    Name: Keeper name
    Status: Success
    Chain: Chain name
    Contract Name: Contract name
    Contract Address: Contract address
    Function Name: Function name
    Function Arguments: Function arguments listed as `key(input name): value` separated by a comma
    Function Output: Output of function returned as `key(output name): value` separated by a comma
    From Address: KeeperHub wallet address
    Transaction Hash: Transaction hash
    Gas Limit: Gas limit (e.g. 117,931)
    Max Fee Per Gas: Max fee per gas in wei (e.g. 1,000,000 wei)
    Max Priority Fee Per Gas: Max priority fee per gas in wei (e.g. 1,000,000 wei)
    Nonce: Nonce number
    Attempts: Number of attempts
    Notification Sent: Discord to `Discord channel name` (if sent), Slack to `Slack channel name`(if sent), email to `Email address`(if sent). If none then display `No notifications sent.`
    Transfer Sent: `transfer_amount` to `recipient_address`. If no transfer then display `No transfer sent`
    Webhook Sent: `webhook_name` (e.g. My Favourite Webhook). If no webhook sent then display `No webhook sent`

## Contract Keeper with Write Function (Failure)

    Timestamp: YYYY-MM-DD HH:MM:SS UTC
    Name: Keeper name
    Status: Failure
    Chain: Chain name
    Contract Name: Contract name
    Contract Address: Contract address
    Function Name: Function name
    Function Arguments: Function arguments listed as `key(input name): value` separated by a comma
    Output: Output of function returned as `key(output name): value` separated by a comma
    From Address: KeeperHub wallet address
    Gas Limit: Gas limit (e.g. 117,931)
    Max Fee Per Gas: Max fee per gas in wei (e.g. 1,000,000 wei)
    Max Priority Fee Per Gas: Max priority fee per gas in wei (e.g. 1,000,000 wei)
    Error Code: Error code (e.g. INSUFFICIENT_FUNDS, GAS_LIMIT_EXCEEDED)
    Error Message: Error message (e.g. Transaction failed)
    Initial Gas Estimate: Initial gas estimate (e.g. 25,826)
    Final Gas Attempt: Final gas attempt (e.g. 296,999)
    Attempts: Number of attempts made (e.g. 10)
    Notification Sent: Discord to `Discord channel name` (if sent), Slack to `Slack channel name`(if sent), email to `Email address`(if sent). If none then display `No notifications sent.`
    Transfer Sent: `transfer_amount` to `recipient_address`. If no transfer then display `No transfer sent`
    Webhook Sent: `webhook_name` (e.g. My Favourite Webhook). If no webhook sent then display `No webhook sent`

## Contract Keeper with Event Trigger

    Timestamp: YYYY-MM-DD HH:MM:SS UTC
    Name: Keeper name
    Chain: Chain name
    Contract Address: Contract address
    Event Name: Event name
    Conditions: List of conditions as `key(input name): value` separated by operator `and(&&)`, `or(||)`, `greater than(>)` or `less than(<)`
    Conditions Returns: `True` or `False`
    Notification Sent: Discord to `Discord channel name` (if sent), Slack to `Slack channel name`(if sent), email to `Email address`(if sent). If none then display `No notifications sent.`
    Transfer Sent: `transfer_amount` to `recipient_address`. If no transfer then display `No transfer sent`
    Webhook Sent: `webhook_name` (e.g. My Favourite Webhook). If no webhook sent then display `No webhook sent`

## Wallet Keeper

    Timestamp: YYYY-MM-DD HH:MM:SS UTC
    Name: Keeper name
    Chain: Chain name
    Wallet Address: Wallet address
    Wallet Balance: Current balance amount
    Conditions: List of conditions as `key(input name): value` separated by operator `and(&&)`, `or(||)`, `greater than(>)` or `less than(<)`
    Conditions Returns: `True` or `False`
    Notification Sent: Discord to `Discord channel name` (if sent), Slack to `Slack channel name`(if sent), email to `Email address`(if sent). If none then display `No notifications sent.`
    Transfer Sent: `transfer_amount` to `recipient_address`. If no transfer then display `No transfer sent`
    Webhook Sent: `webhook_name` (e.g. My Favourite Webhook). If no webhook sent then display `No webhook sent`

## Multisig Keeper

    Timestamp: YYYY-MM-DD HH:MM:SS UTC
    Name: Keeper name
    Chain: Chain name
    Multisig Address: Multisig wallet address
    Event Name: eg. OwnerAdded/OwnerRemoved/ThresholdChanged
    Transaction Hash: Transaction hash of the change
    Conditions: List of conditions as `key(input name): value` separated by operator `and(&&)`, `or(||)`, `greater than(>)` or `less than(<)`
    Conditions Returns: `True` or `False`
    Notification Sent: Discord to `Discord channel name` (if sent), Slack to `Slack channel name`(if sent), email to `Email address`(if sent). If none then display `No notifications sent.`
    Transfer Sent: `transfer_amount` to `recipient_address`. If no transfer then display `No transfer sent`
    Webhook Sent: `webhook_name` (e.g. My Favourite Webhook). If no webhook sent then display `No webhook sent`
