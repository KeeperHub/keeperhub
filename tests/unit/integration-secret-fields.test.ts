import { describe, expect, it } from "vitest";

import {
  getSecretConfigKeys,
  mergeSecretConfig,
  stripSecretConfig,
} from "@/lib/integrations/secret-fields";

describe("getSecretConfigKeys", () => {
  it("derives secret keys from a plugin's password fields", () => {
    expect(getSecretConfigKeys("discord")).toEqual(new Set(["webhookUrl"]));
    expect(getSecretConfigKeys("telegram")).toEqual(new Set(["botToken"]));
    expect(getSecretConfigKeys("sendgrid")).toEqual(new Set(["apiKey"]));
  });

  it("declares secret keys for system integrations with no plugin", () => {
    expect(getSecretConfigKeys("database")).toEqual(
      new Set(["password", "url"])
    );
  });

  it("returns null for an unrecognised type", () => {
    expect(getSecretConfigKeys("not-a-real-integration")).toBeNull();
  });
});

describe("stripSecretConfig", () => {
  it("strips password and url from database integrations", () => {
    const config = {
      host: "db.example.com",
      port: "5432",
      username: "postgres",
      password: "secret123",
      database: "mydb",
      url: "postgresql://postgres:secret123@db.example.com:5432/mydb",
    };

    const result = stripSecretConfig(config, "database");

    expect(result).toEqual({
      host: "db.example.com",
      port: "5432",
      username: "postgres",
      database: "mydb",
    });
  });

  it("strips the credential of every plugin declaring a password field", () => {
    expect(
      stripSecretConfig({ webhookUrl: "https://discord.com/hook" }, "discord")
    ).toEqual({});
    expect(stripSecretConfig({ botToken: "123:abc" }, "telegram")).toEqual({});
    expect(
      stripSecretConfig(
        { apiKey: "sk-1", apiUrl: "https://blockscout.example" },
        "blockscout"
      )
    ).toEqual({ apiUrl: "https://blockscout.example" });
  });

  it("strips everything for an unrecognised type", () => {
    expect(
      stripSecretConfig({ apiKey: "sk-1" }, "not-a-real-integration")
    ).toEqual({});
  });

  it("handles empty config", () => {
    expect(stripSecretConfig({}, "database")).toEqual({});
  });
});

describe("mergeSecretConfig", () => {
  it("preserves an existing secret when the incoming value is empty", () => {
    const result = mergeSecretConfig(
      { webhookUrl: "https://discord.com/api/webhooks/stored" },
      { webhookUrl: "" },
      "discord"
    );

    expect(result.webhookUrl).toBe("https://discord.com/api/webhooks/stored");
  });

  it("preserves an existing secret when the key is absent", () => {
    const result = mergeSecretConfig(
      { apiKey: "sk-stored", apiUrl: "https://old.example" },
      { apiUrl: "https://new.example" },
      "blockscout"
    );

    expect(result.apiKey).toBe("sk-stored");
    expect(result.apiUrl).toBe("https://new.example");
  });

  it("overwrites a secret when the incoming value is non-empty", () => {
    const result = mergeSecretConfig(
      { botToken: "old-token" },
      { botToken: "new-token" },
      "telegram"
    );

    expect(result.botToken).toBe("new-token");
  });

  it("overwrites non-secret fields unconditionally", () => {
    const result = mergeSecretConfig(
      { host: "old-host.com", port: "5432", password: "pass" },
      { host: "", port: "5433" },
      "database"
    );

    expect(result.host).toBe("");
    expect(result.port).toBe("5433");
    expect(result.password).toBe("pass");
  });

  it("keeps every existing value for an unrecognised type", () => {
    const result = mergeSecretConfig(
      { apiKey: "sk-stored" },
      { apiKey: "" },
      "not-a-real-integration"
    );

    expect(result.apiKey).toBe("sk-stored");
  });

  it("does not mutate the existing config", () => {
    const existing = { host: "old", password: "pass" };
    const copy = { ...existing };

    mergeSecretConfig(existing, { host: "new" }, "database");

    expect(existing).toEqual(copy);
  });
});

describe("no plugin leaks a credential through a response", () => {
  it("strips every password field declared by every plugin", async () => {
    const { getAllIntegrations } = await import("@/plugins/registry");

    for (const plugin of getAllIntegrations()) {
      const secretFields = plugin.formFields.filter(
        (field) => field.type === "password"
      );
      if (secretFields.length === 0) {
        continue;
      }

      const config = Object.fromEntries(
        secretFields.map((field) => [field.configKey, "leaked-credential"])
      );
      const stripped = stripSecretConfig(config, plugin.type);

      expect(Object.values(stripped)).not.toContain("leaked-credential");
    }
  });
});
