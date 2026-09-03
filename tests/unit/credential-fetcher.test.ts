/**
 * Regression tests for the credential mapping pipeline.
 *
 * Background: Workflow DevKit step bundles cannot statically analyze the
 * dynamic require("@/plugins") inside ensurePluginsLoaded(), so the runtime
 * plugin registry is empty inside step bundles. The credential fetcher must
 * therefore work without depending on the runtime registry. Plugins like
 * Telegram, Slack, and SendGrid (with custom API key) silently broke between
 * 2026-03-12 and 2026-04-28 because the previous fallback returned raw
 * configKey-keyed credentials instead of the envVar-keyed credentials the
 * step files actually read.
 *
 * These tests pin the static credential map so the same regression cannot
 * recur without flagging in CI.
 */

import { describe, expect, it, vi } from "vitest";
import { PLUGIN_CREDENTIAL_MAP } from "@/lib/credential-map";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/integrations", () => ({
  getIntegrationById: vi.fn(),
}));
vi.mock("@/lib/integrations/authorization", () => ({
  filterUnauthorizedIntegrationIds: vi.fn().mockResolvedValue([]),
}));

const ORG_PRINCIPAL = { organizationId: "org_1" };

type ExpectedMapping = {
  type: string;
  configKey: string;
  envVar: string;
  reason: string;
};

const KNOWN_MAPPINGS: ExpectedMapping[] = [
  {
    type: "telegram",
    configKey: "botToken",
    envVar: "TELEGRAM_BOT_TOKEN",
    reason: "telegram step reads credentials.TELEGRAM_BOT_TOKEN",
  },
  {
    type: "slack",
    configKey: "apiKey",
    envVar: "SLACK_API_KEY",
    reason: "slack step reads credentials.SLACK_API_KEY",
  },
  {
    type: "sendgrid",
    configKey: "apiKey",
    envVar: "SENDGRID_API_KEY",
    reason:
      "sendgrid step reads credentials.SENDGRID_API_KEY when useKeeperHubApiKey is false",
  },
  {
    type: "discord",
    configKey: "webhookUrl",
    envVar: "webhookUrl",
    reason: "discord step reads credentials.webhookUrl",
  },
  {
    type: "safe",
    configKey: "apiKey",
    envVar: "apiKey",
    reason: "safe protocol step reads credentials.apiKey",
  },
];

describe("PLUGIN_CREDENTIAL_MAP", () => {
  it.each(
    KNOWN_MAPPINGS
  )("$type maps configKey '$configKey' to envVar '$envVar' ($reason)", ({
    type,
    configKey,
    envVar,
  }) => {
    const fieldMap = PLUGIN_CREDENTIAL_MAP[type];
    expect(
      fieldMap,
      `PLUGIN_CREDENTIAL_MAP missing entry for "${type}". ` +
        "Run 'pnpm discover-plugins' to regenerate lib/credential-map.ts."
    ).toBeDefined();
    expect(
      fieldMap?.[configKey],
      `Expected ${type}.${configKey} -> ${envVar} but got ${fieldMap?.[configKey]}`
    ).toBe(envVar);
  });

  it("contains every credential field for every registered plugin", async () => {
    const { getAllIntegrations } = await import("@/plugins/registry");
    const integrations = getAllIntegrations();

    const missing: string[] = [];
    for (const integration of integrations) {
      for (const field of integration.formFields) {
        if (!field.envVar) {
          continue;
        }
        const fieldMap = PLUGIN_CREDENTIAL_MAP[integration.type];
        if (fieldMap?.[field.configKey] !== field.envVar) {
          missing.push(
            `${integration.type}.${field.configKey} -> ${field.envVar}`
          );
        }
      }
    }

    expect(
      missing,
      "PLUGIN_CREDENTIAL_MAP is out of sync with the runtime plugin registry. " +
        "Run 'pnpm discover-plugins' to regenerate lib/credential-map.ts."
    ).toEqual([]);
  });
});

describe("mapIntegrationConfig (via fetchCredentials)", () => {
  it.each(
    KNOWN_MAPPINGS
  )("$type returns credentials keyed by envVar '$envVar'", async ({
    type,
    configKey,
    envVar,
  }) => {
    const { getIntegrationById } = await import("@/lib/db/integrations");
    const { fetchCredentials } = await import("@/lib/credential-fetcher");

    vi.mocked(getIntegrationById).mockResolvedValueOnce({
      id: "int_test",
      type,
      config: { [configKey]: "secret-value" },
    } as Awaited<ReturnType<typeof getIntegrationById>>);

    const creds = await fetchCredentials("int_test", ORG_PRINCIPAL);
    expect(creds[envVar]).toBe("secret-value");
  });

  it("returns empty creds without hitting the DB when integrationId is missing", async () => {
    const { getIntegrationById } = await import("@/lib/db/integrations");
    const { fetchCredentials } = await import("@/lib/credential-fetcher");

    vi.mocked(getIntegrationById).mockClear();

    // Must short-circuit before getIntegrationById(undefined) throws.
    const creds = await fetchCredentials(
      undefined as unknown as string,
      ORG_PRINCIPAL
    );

    expect(creds).toEqual({});
    expect(getIntegrationById).not.toHaveBeenCalled();
  });

  it("returns empty creds for unknown integration types", async () => {
    const { getIntegrationById } = await import("@/lib/db/integrations");
    const { fetchCredentials } = await import("@/lib/credential-fetcher");

    vi.mocked(getIntegrationById).mockResolvedValueOnce({
      id: "int_test",
      type: "not-a-plugin",
      config: { someKey: "someValue" },
    } as unknown as Awaited<ReturnType<typeof getIntegrationById>>);

    const creds = await fetchCredentials("int_test", ORG_PRINCIPAL);
    expect(creds).toEqual({});
  });

  it("returns no creds and skips the DB when the principal is not authorized for the integration (cross-org)", async () => {
    const { getIntegrationById } = await import("@/lib/db/integrations");
    const { filterUnauthorizedIntegrationIds } = await import(
      "@/lib/integrations/authorization"
    );
    const { fetchCredentials } = await import("@/lib/credential-fetcher");

    vi.mocked(getIntegrationById).mockClear();
    // The integration belongs to another org -> authorization marks it invalid.
    vi.mocked(filterUnauthorizedIntegrationIds).mockResolvedValueOnce([
      "int_other_org",
    ]);

    const creds = await fetchCredentials("int_other_org", ORG_PRINCIPAL);

    expect(creds).toEqual({});
    expect(getIntegrationById).not.toHaveBeenCalled();
  });
});
