import postgres from "postgres";
import { assertConnectionUrlIsPublic } from "@/lib/db/connection-host-guard";
import {
  buildDatabaseUrlFromConfig,
  type DatabaseConnectionConfig,
  getDatabaseErrorMessage,
  getPostgresConnectionOptions,
} from "@/lib/db/connection-utils";
import { assertUrlIsPublic, SsrfBlockedError } from "@/lib/safe-fetch";
import type { IntegrationType } from "@/lib/types/integration";
import {
  getCredentialMapping,
  getIntegration as getPluginFromRegistry,
  type IntegrationPlugin,
} from "@/plugins/registry";

export type TestConnectionResult = {
  status: "success" | "error";
  message: string;
};

export async function testDatabaseConnection(
  databaseUrl: string,
  sslMode?: string
): Promise<TestConnectionResult> {
  let connection: postgres.Sql | null = null;

  try {
    const { normalizedUrl, ssl } = getPostgresConnectionOptions(
      databaseUrl,
      sslMode
    );

    try {
      await assertConnectionUrlIsPublic(normalizedUrl);
    } catch (guardError) {
      return {
        status: "error",
        message:
          guardError instanceof Error
            ? guardError.message
            : "Host is not allowed: must resolve to a public address",
      };
    }

    connection = postgres(normalizedUrl, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 5,
      ssl,
    });

    await connection`SELECT 1`;

    return {
      status: "success",
      message: "Connection successful",
    };
  } catch (error) {
    return {
      status: "error",
      message: getDatabaseErrorMessage(error),
    };
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

export async function handleDatabaseTest(
  config: Record<string, unknown>
): Promise<TestConnectionResult> {
  const url = buildDatabaseUrlFromConfig(config as DatabaseConnectionConfig);
  if (!url) {
    return {
      status: "error",
      message:
        "Provide a connection string or connection details (host, username, password, database).",
    };
  }
  const sslMode =
    typeof config.sslMode === "string" ? config.sslMode : undefined;
  return await testDatabaseConnection(url, sslMode);
}

/**
 * Connection-test files (plugins/*\/test.ts) are reachable from the
 * client-bundled plugin registry, so they cannot import the server-only SSRF
 * guard and fetch user-supplied instance URLs with raw `fetch`. Validate every
 * user-supplied URL field here, on the server, before the test runs, mirroring
 * the assertConnectionUrlIsPublic pre-flight used for database connection
 * tests. This is a write-time DNS check; the test's own one-shot fetch happens
 * immediately after, so the rebinding window is negligible.
 *
 * Note: `assertUrlIsPublic` is always-on; it does not honor
 * `SAFE_FETCH_SHADOW`, matching the database-test and RPC pre-flights. So
 * "Test Connection" blocks a `localhost`/private instance URL even in local
 * dev, where `safeFetch` (used by workflow execution) runs in shadow mode and
 * would allow it. If you need to test against a local explorer in dev, run the
 * workflow rather than the connection test, or point at a public instance.
 */
async function assertPluginUrlFieldsArePublic(
  plugin: IntegrationPlugin,
  config: Record<string, unknown>
): Promise<TestConnectionResult | null> {
  for (const field of plugin.formFields) {
    if (field.type !== "url") {
      continue;
    }
    const value = config[field.configKey];
    if (typeof value !== "string" || value.trim() === "") {
      continue;
    }
    try {
      await assertUrlIsPublic(value.trim());
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return { status: "error", message: `${field.label}: ${error.message}` };
      }
      return {
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "URL is invalid or could not be resolved",
      };
    }
  }
  return null;
}

export async function handlePluginTest(
  type: IntegrationType | string,
  config: Record<string, unknown>
): Promise<TestConnectionResult> {
  const plugin = getPluginFromRegistry(type as IntegrationType);
  if (!plugin) {
    return { status: "error", message: "Invalid integration type" };
  }
  if (!plugin.testConfig) {
    return { status: "error", message: "Integration does not support testing" };
  }
  const urlGuard = await assertPluginUrlFieldsArePublic(plugin, config);
  if (urlGuard) {
    return urlGuard;
  }
  const credentials = getCredentialMapping(plugin, config);
  const testFn = await plugin.testConfig.getTestFunction();
  const testResult = await testFn(credentials);
  return {
    status: testResult.success ? "success" : "error",
    message: testResult.success
      ? "Connection successful"
      : testResult.error || "Connection failed",
  };
}
