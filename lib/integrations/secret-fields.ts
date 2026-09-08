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
