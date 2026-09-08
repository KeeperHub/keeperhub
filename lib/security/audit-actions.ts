/**
 * Human-readable descriptions for security audit-log `action` values, used by
 * the activity feed. `phrase` completes "{actor} ___" (e.g. "created an API
 * key"); `kind` drives the row icon/color (add = green, remove = red, change =
 * amber). Any action not listed falls back to a humanized dotted name.
 */

export type AuditActionKind = "add" | "remove" | "change";

export type AuditActionDescription = {
  phrase: string;
  kind: AuditActionKind;
};

const ACTION_MAP: Record<string, AuditActionDescription> = {
  "api_key.created": { phrase: "created an API key", kind: "add" },
  "api_key.revoked": { phrase: "revoked an API key", kind: "remove" },
  "org_api_key.created": { phrase: "created an org API key", kind: "add" },
  "org_api_key.revoked": { phrase: "revoked an org API key", kind: "remove" },
  "password.changed": { phrase: "changed their password", kind: "change" },
  "password.reset": { phrase: "reset their password", kind: "change" },
  "email.changed": { phrase: "changed their email", kind: "change" },
  "account.deactivated": { phrase: "deactivated the account", kind: "remove" },
  "session.revoked": { phrase: "revoked a session", kind: "remove" },
  "totp.enrolled": { phrase: "enabled two-factor auth", kind: "add" },
  "totp.disabled": { phrase: "disabled two-factor auth", kind: "remove" },
  "backup_codes.regenerated": {
    phrase: "regenerated backup codes",
    kind: "change",
  },
  "integration.created": { phrase: "added an integration", kind: "add" },
  "integration.updated": { phrase: "updated an integration", kind: "change" },
  "integration.deleted": { phrase: "removed an integration", kind: "remove" },
  "workflow.created": { phrase: "created a workflow", kind: "add" },
  "workflow.updated": { phrase: "updated a workflow", kind: "change" },
  "workflow.deleted": { phrase: "deleted a workflow", kind: "remove" },
  "workflow.listed": { phrase: "listed a workflow", kind: "add" },
  "workflow.unlisted": { phrase: "unlisted a workflow", kind: "remove" },
  "workflow.listing_updated": {
    phrase: "updated a workflow listing",
    kind: "change",
  },
  "subscription.plan_changed": { phrase: "changed the plan", kind: "change" },
  "subscription.canceled": {
    phrase: "canceled the subscription",
    kind: "remove",
  },
  "subscription.change_requested": {
    phrase: "requested a plan change",
    kind: "change",
  },
  "subscription.cancel_requested": {
    phrase: "requested cancellation",
    kind: "change",
  },
  "subscription.checkout_started": {
    phrase: "started checkout",
    kind: "change",
  },
  "session.created": { phrase: "signed in", kind: "add" },
  "workflow.deactivated": { phrase: "deactivated a workflow", kind: "remove" },
  "workflow.reactivated": { phrase: "reactivated a workflow", kind: "add" },
  "agentic_wallet.signed": {
    phrase: "signed a wallet operation",
    kind: "change",
  },
  "agentic_wallet.linked": { phrase: "linked a wallet", kind: "add" },
  "wallet.funds_withdrawn": { phrase: "withdrew funds", kind: "change" },
  "safe_role.installed": { phrase: "installed Safe roles", kind: "add" },
  "safe_role.updated": { phrase: "updated Safe roles", kind: "change" },
  "safe_role_allowance.created": {
    phrase: "set a spending allowance",
    kind: "add",
  },
  "safe_role_allowance.updated": {
    phrase: "updated a spending allowance",
    kind: "change",
  },
  "safe_role_allowance.revoked": {
    phrase: "revoked a spending allowance",
    kind: "remove",
  },
  "org_wallet.created": { phrase: "created an org wallet", kind: "add" },
  "agentic_wallet.hmac_rotated": {
    phrase: "rotated a wallet signing key",
    kind: "change",
  },
  "agentic_wallet.approval_granted": {
    phrase: "approved a wallet action",
    kind: "add",
  },
  "agentic_wallet.approval_denied": {
    phrase: "rejected a wallet action",
    kind: "remove",
  },
  "wallet.private_key_exported": {
    phrase: "exported a wallet private key",
    kind: "change",
  },
  "org.updated": { phrase: "updated the organization", kind: "change" },
  "org.deactivated": {
    phrase: "deactivated the organization",
    kind: "remove",
  },
  "org.reactivated": {
    phrase: "reactivated the organization",
    kind: "add",
  },
  "org.digest_settings_changed": {
    phrase: "changed execution-digest settings",
    kind: "change",
  },
  "account.reactivated": { phrase: "reactivated the account", kind: "add" },
  "member.invited": { phrase: "invited a member", kind: "add" },
  "member.joined": { phrase: "joined the organization", kind: "add" },
  "member.left": { phrase: "left the organization", kind: "remove" },
  "member.removed": { phrase: "removed a member", kind: "remove" },
  "member.role_changed": {
    phrase: "changed a member's role",
    kind: "change",
  },
  "project.created": { phrase: "created a project", kind: "add" },
  "project.updated": { phrase: "updated a project", kind: "change" },
  "project.deleted": { phrase: "deleted a project", kind: "remove" },
  "tag.created": { phrase: "created a tag", kind: "add" },
  "tag.updated": { phrase: "updated a tag", kind: "change" },
  "tag.deleted": { phrase: "deleted a tag", kind: "remove" },
  "public_tag.created": { phrase: "created a public tag", kind: "add" },
  "mcp_connection.created": { phrase: "connected an AI agent", kind: "add" },
  "mcp_connection.revoked": {
    phrase: "disconnected an AI agent",
    kind: "remove",
  },
  "mcp_member_scope.changed": {
    phrase: "changed what a member's AI agents may do",
    kind: "change",
  },
  "mcp_policy.updated": {
    phrase: "changed the organization's AI agent limit",
    kind: "change",
  },
};

const DELIMITERS = /[._]/g;

function humanizeFallback(action: string): string {
  // "some.unknown_action" -> "some unknown action"
  return action.replace(DELIMITERS, " ").trim();
}

export function describeAuditAction(action: string): AuditActionDescription {
  return (
    ACTION_MAP[action] ?? { phrase: humanizeFallback(action), kind: "change" }
  );
}
