---
title: "Security Best Practices"
description: "Security recommendations for KeeperHub users - wallet security, keeper configuration, and operational guidelines."
---

# Security Best Practices

## Wallet Security

**Monitor Balances**: Regularly check your Turnkey wallet balance to ensure adequate funding for keeper operations.

**Withdraw Unused Funds**: Use the Withdraw function to remove excess ETH from your KeeperHub wallet when not needed.

**Network Selection**: Use Sepolia testnet for testing and experimentation before deploying to Mainnet.

## Keeper Configuration

**Condition Validation**: Test keeper conditions thoroughly before activation to prevent unintended executions.

**Spending Limits**: Be mindful of transfer amounts in Filler keepers and action configurations.

**Address Verification**: Double-check all wallet and contract addresses before saving keeper configurations.

## Multisig Monitoring

**Owner Verification**: When configuring Multisig keepers, verify both proxy and implementation addresses.

**Threshold Awareness**: Monitor multisig threshold changes that could affect security posture.

**Regular Audits**: Review multisig ownership changes and transaction patterns regularly.

## Access Management

**Account Security**: Use strong passwords and secure email addresses for KeeperHub accounts.

**Organization Controls**: Properly configure team and organization access when working with multiple users.

**Regular Reviews**: Periodically review active keepers and their configurations.

## Notification Security

**Webhook URLs**: Only use HTTPS endpoints for webhook notifications.

**Sensitive Data**: Avoid including private keys or sensitive information in notification payloads.

**Channel Security**: Ensure Discord and Slack channels have appropriate access controls.

## Operational Security

**Test First**: Always test new keepers on Sepolia before deploying to Mainnet.

**Monitor Runs**: Regularly check keeper run logs and status for anomalies.

**Emergency Procedures**: Know how to quickly disable keepers if needed.