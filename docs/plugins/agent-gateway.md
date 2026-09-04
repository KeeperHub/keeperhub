---
title: "Agent Gateway Plugin"
description: "Non-custodial agentic wallet integration for credit balance checks and workflow payment challenge signing."
---

# Agent Gateway Plugin

The **Agent Gateway** plugin enables workflow graphs and autonomous AI agents to query their agentic wallet credit balance and produce Turnkey-backed cryptographic payment signatures for KeeperHub marketplace workflows.

All signing requests are authenticated using HMAC authentication (`X-KH-Sub-Org`, `X-KH-Timestamp`, `X-KH-Signature`) and forwarded to KeeperHub's canonical `/api/agentic-wallet/*` endpoints. Private keys remain strictly isolated within Turnkey policy enclaves and are never exposed to workflow steps or logs.

---

## Credentials Setup

Credentials for the Agent Gateway plugin are provisioned out-of-band and stored as an Integration in KeeperHub:

1. **Provision Wallet**: Submit a request to the unauthenticated provisioning endpoint:
   ```bash
   curl -X POST https://app.keeperhub.com/api/agentic-wallet/provision
   ```
   This returns a JSON payload containing:
   * `subOrgId`: The unique identifier of the provisioned Turnkey sub-organization.
   * `hmacSecret`: The shared HMAC secret used to sign API requests.

> [!WARNING]
> The `hmacSecret` is displayed only once upon initial provisioning and cannot be retrieved again. Store it securely in your secrets manager.

2. **Configure Connection**:
   * Navigate to **Settings** -> **Integrations** -> **Agent Gateway**.
   * Enter your `Sub-Org ID` and `HMAC Secret`.
   * Click **Test Connection** to verify cryptographic connectivity against `/api/agentic-wallet/credit`.

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
  * `approvalRequestId`: Present when human-in-the-loop review is required by sub-org risk policy.
  *(Note: To eliminate bearer payment authorization exposure, raw signatures are omitted from public workflow outputFields and retained exclusively in internal execution step state).*

---

## Security & Architectural Invariants

1. **Zero Private Key Custody:** Workflow steps never hold, inspect, or pass private keys. All cryptographic signing occurs inside hardware-isolated Turnkey enclaves.
2. **Workflow-Bound Payment Gating:** Payment challenges must match registered marketplace workflows by slug; arbitrary third-party payees or unbounded amounts are rejected at the route handler level with `403 Forbidden`.
3. **Timestamp Window & Double-Spend Prevention:** HMAC request signatures are valid within a symmetric 300-second window to bound replay exposure, while underlying x402/MPP protocol nonces enforce single-use execution at the settlement layer.
4. **Sensitive Data Redaction:** Authorization tokens, secrets, and private credentials are automatically filtered by KeeperHub's redaction pipeline before rendering in workflow execution panels.
