/**
 * How a recorded action authenticated, resolved for display.
 *
 * An org API key carries its creator's user id, so an action taken through
 * one is attributed to that person. That is correct as far as it goes -- the
 * key is theirs -- but on its own it reads as "this person edited it", which
 * is wrong whenever a team shares a key. Carrying the credential alongside
 * the actor is what makes the difference visible.
 */
export type ActorCredential = {
  /** session | api-key | oauth | internal | unknown */
  authMethod: string;
  /** Name of the API key used, when one was and it still exists. */
  apiKeyName: string | null;
};

/**
 * Short suffix for an actor line, e.g. "via Sky MCP key". Null for a normal
 * signed-in edit, where the actor alone already says everything.
 */
export function credentialLabel(
  credential: ActorCredential | null | undefined
): string | null {
  if (!credential) {
    return null;
  }
  if (credential.authMethod === "api-key") {
    // Name the key, and say it was a key: the actor is only its creator, so
    // the credential type is half of what makes the row unambiguous.
    return credential.apiKeyName
      ? `via API Key - ${credential.apiKeyName}`
      : "via API Key";
  }
  if (credential.authMethod === "oauth") {
    return "via OAuth app";
  }
  if (credential.authMethod === "internal") {
    return "via system";
  }
  return null;
}
