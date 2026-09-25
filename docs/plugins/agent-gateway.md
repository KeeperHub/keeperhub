---
title: "Agent Gateway Plugin"
description: "Non-custodial agentic wallet integration for credit balance checks and workflow payment challenge signing."
---

# Agent Gateway Plugin

The **Agent Gateway** plugin enables workflow graphs and autonomous AI agents to query their agentic wallet credit balance and produce Turnkey-backed cryptographic payment signatures for KeeperHub marketplace workflows.

All signing requests are authenticated using HMAC authentication (`X-KH-Sub-Org`, `X-KH-Timestamp`, `X-KH-Signature`) and forwarded to KeeperHub's canonical `/api/agentic-wallet/*` endpoints. Private keys remain strictly isolated within Turnkey policy enclaves and are never exposed to workflow steps or logs.

---

## Credentials Setup

Credentials for the Agent Gateway plugin link your workflow steps to a Turnkey-backed agent sub-organization:

1. **Provision Agent Wallet**:
   Call the provisioning endpoint to create an agent sub-organization and retrieve signing credentials:
   ```bash
   curl -X POST https://app.keeperhub.com/api/agentic-wallet/provision
   ```
   This returns `{ subOrgId, walletAddress, hmacSecret }`.

2. **Configure Connection**:
   * Navigate to **Connections** in KeeperHub settings and select **Agent Gateway**.
   * Enter the returned `Sub-Org ID` and `HMAC Secret`.
   * Click **Test** to verify connectivity against `/api/agentic-wallet/credit`.

> [!WARNING]
> The `hmacSecret` is generated once upon initial provisioning and cannot be retrieved later. Store it securely in your secrets manager.

---

## Actions

| Action | Description |
|--------|-------------|
| **Check Credit Balance** | Reads the available credit balance for the agentic sub-org wallet in USD. |
| **Sign Payment Challenge** | Signs an x402 (Base) or MPP (Tempo) payment challenge for a KeeperHub marketplace workflow. |

---

## Check Credit Balance

Queries the off-chain credit ledger to inspect remaining operational balance.

* **Inputs:** Requires a configured Agent Gateway connection.
* **Outputs:**
  * `success`: Whether the credit query succeeded.
  * `amount`: Available credit balance formatted as a USD decimal string (e.g. `"25.50"`).
  * `currency`: Currency denomination (`"USD"`).
  * `subOrgId`: The verified sub-organization ID.

---

## Sign Payment Challenge

Requests a Turnkey-backed cryptographic payment authorization for a KeeperHub marketplace workflow.

* **Inputs:**
  * `Chain`: Target settlement network (`"base"` for x402, `"tempo"` for MPP).
  * `Workflow Slug`: The slug of the KeeperHub marketplace workflow being paid for. Required: `/api/agentic-wallet/sign` derives the recipient address (`payTo`) and required payment amount directly from the workflow registry.
  * `Payment Challenge`: The 402/WWW-Authenticate payment challenge payload.
* **Outputs:**
  * `success`: Boolean indicating whether the signing operation succeeded.
  * `status`: Current state (`"signed"`, `"pending_approval"`, `"blocked"`, or `"error"`).
  * `signature`: Turnkey-backed signature for the payment challenge (present when status is `"signed"`).
  * `approvalRequestId`: Present when human-in-the-loop review is required by sub-org risk policy.

---

## Security & Architectural Invariants

1. **Zero Private Key Custody:** Workflow steps never hold, inspect, or pass private keys. All cryptographic signing occurs inside hardware-isolated Turnkey enclaves.
2. **Workflow-Bound Payment Gating:** Payment challenges must match registered marketplace workflows by slug; arbitrary third-party payees or unbounded amounts are rejected at the route handler level with `403 Forbidden`.
3. **Timestamp Window & Double-Spend Prevention:** HMAC request signatures are valid within a symmetric 300-second window to bound replay exposure, while underlying x402/MPP protocol nonces enforce single-use execution at the settlement layer.
4. **Credential Storage Protection:** Configuration secrets (such as HMAC request secrets) are encrypted at rest with AES-256-GCM and stripped entirely from any connection-read response before it leaves the server. The HMAC secret is returned only upon initial provisioning and rotation (`/api/agentic-wallet/rotate-hmac`).
