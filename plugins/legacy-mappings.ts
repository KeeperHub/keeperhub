/**
 * Legacy Action Mappings
 *
 * This file maps old action type names to new namespaced action IDs.
 * Used for backward compatibility with existing workflows.
 *
 * Format: "Old Label" -> "plugin-type/action-slug"
 *
 * TODO: Remove this file once all workflows have been migrated to the new format.
 */
export const LEGACY_ACTION_MAPPINGS: Record<string, string> = {
  // Firecrawl
  Scrape: "firecrawl/scrape",
  Search: "firecrawl/search",

  // AI Gateway
  "Generate Text": "ai-gateway/generate-text",
  "Generate Image": "ai-gateway/generate-image",

  // Resend
  "Send Email": "resend/send-email",

  // Linear
  "Create Ticket": "linear/create-ticket",
  "Find Issues": "linear/find-issues",

  // Slack
  "Send Slack Message": "slack/send-message",

  // v0
  "Create Chat": "v0/create-chat",
  "Send Message": "v0/send-message",

  // Safe: the get-pending-transactions action lives in the safe plugin but is
  // injected into safe-wallet at runtime. This alias ensures the step registry
  // has an entry for safe-wallet/get-pending-transactions.
  "safe-wallet/get-pending-transactions": "safe/get-pending-transactions",

  // Web3
  "Check Balance": "web3/check-balance",
  "Transfer Funds": "web3/transfer-funds",
  "Read Contract": "web3/read-contract",
  "Write Contract": "web3/write-contract",
};

