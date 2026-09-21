import type {
  IntegrationConfig,
  IntegrationType,
} from "@/lib/types/integration";
import { getIntegration as getPluginDefinition } from "@/plugins/registry";

/**
 * Secret config keys for integration types that have no plugin definition to
 * derive them from. `url` is a full connection string and carries the password.
 */
const SYSTEM_SECRET_CONFIG_KEYS: Record<string, readonly string[]> = {
  database: ["password", "url"],
};

/**
 * Config keys holding a credential for the given integration type. Derived
 * from the plugin's `formFields`, so a new plugin declaring a `password` field
 * is covered without touching this module.
 *
 * Returns null for a type that is neither a registered plugin nor a known
 * system integration. Callers treat that as "every key is a secret" so an
 * unrecognised type cannot fall through to an unfiltered response.
 */
export function getSecretConfigKeys(
  integrationType: IntegrationType | string
): Set<string> | null {
  const systemKeys = SYSTEM_SECRET_CONFIG_KEYS[integrationType];
  if (systemKeys) {
    return new Set(systemKeys);
  }

  const plugin = getPluginDefinition(integrationType as IntegrationType);
  if (!plugin) {
    return null;
  }

  const keys = new Set<string>();
  for (const field of plugin.formFields) {
    if (field.type === "password") {
      keys.add(field.configKey);
    }
  }
  return keys;
}

export function isSecretConfigKey(
  integrationType: IntegrationType | string,
  configKey: string
): boolean {
  const secretKeys = getSecretConfigKeys(integrationType);
  return secretKeys === null || secretKeys.has(configKey);
}

/**
 * Remove every credential value from a config before it leaves the server.
 * Applies to all integration types: a stored credential is never readable
 * back by a client, whatever role or credential the caller holds.
 */
export function stripSecretConfig(
  config: IntegrationConfig,
  integrationType: IntegrationType | string
): IntegrationConfig {
  const secretKeys = getSecretConfigKeys(integrationType);
  if (secretKeys === null) {
    return {};
  }
  if (secretKeys.size === 0) {
    return config;
  }

  const stripped: IntegrationConfig = {};
  for (const key of Object.keys(config)) {
    if (!secretKeys.has(key)) {
      stripped[key] = config[key];
    }
  }
  return stripped;
}

/**
 * Merge an incoming config over the stored one, keeping a stored secret when
 * the update leaves that field empty. Clients never receive secrets back, so
 * an unchanged secret arrives as blank rather than as its own value.
 */
export function mergeSecretConfig(
  existingConfig: IntegrationConfig,
  incomingConfig: IntegrationConfig,
  integrationType: IntegrationType | string
): IntegrationConfig {
  const secretKeys = getSecretConfigKeys(integrationType);
  const merged: IntegrationConfig = { ...existingConfig };

  for (const [key, value] of Object.entries(incomingConfig)) {
    if (secretKeys === null || secretKeys.has(key)) {
      if (value !== undefined && value !== "") {
        merged[key] = value;
      }
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Remove the keys a caller explicitly asked to clear.
 *
 * `mergeSecretConfig` above cannot express this: a blank secret means
 * "unchanged" there, because the stored value is never sent to the browser
 * and so cannot be sent back. Removing one therefore has to be asked for.
 *
 * A key that also carries a new value in the same request is left alone, so
 * clearing and re-entering in one go keeps what was typed.
 */
export function removeClearedKeys(
  config: IntegrationConfig,
  clearedKeys: readonly string[],
  incomingConfig: IntegrationConfig = {}
): IntegrationConfig {
  if (clearedKeys.length === 0) {
    return config;
  }
  const result: IntegrationConfig = { ...config };
  for (const key of clearedKeys) {
    const replacement = incomingConfig[key];
    // Any value supplied in the same request wins, not only a non-empty
    // string: a checkbox sends a boolean, and deleting a key the caller had
    // just set would be the opposite of what they asked for. An empty string
    // is not a value - it is what an untouched field sends.
    const supplied =
      replacement !== undefined && replacement !== null && replacement !== "";
    if (supplied) {
      continue;
    }
    delete result[key];
  }
  return result;
}

/**
 * Which secret keys this connection actually holds, without their values.
 *
 * Withholding the values is right; withholding "is there one" left the form
 * unable to say which alternative is in use, hold the unused one shut, or
 * warn when both are filled. The key names leak nothing a caller could not
 * infer by trying the connection.
 */
export function storedSecretKeys(
  config: IntegrationConfig,
  integrationType: IntegrationType | string
): string[] {
  const secretKeys = getSecretConfigKeys(integrationType);
  if (secretKeys === null) {
    return [];
  }
  return Object.keys(config).filter(
    (key) =>
      secretKeys.has(key) &&
      typeof config[key] === "string" &&
      (config[key] as string).length > 0
  );
}
