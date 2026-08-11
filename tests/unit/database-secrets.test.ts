import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  mergeDatabaseConfig,
  stripDatabaseSecrets,
} from "@/lib/db/integrations";

describe("stripDatabaseSecrets", () => {
  it("strips password and url from database integrations", () => {
    const config = {
      host: "db.example.com",
      port: "5432",
      username: "postgres",
      password: "secret123",
      database: "mydb",
      url: "postgresql://postgres:secret123@db.example.com:5432/mydb",
    };

    const result = stripDatabaseSecrets(config, "database");

    expect(result).toEqual({
      host: "db.example.com",
      port: "5432",
      username: "postgres",
      database: "mydb",
    });
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("url");
  });

  it("returns config unchanged for non-database integrations", () => {
    const config = {
      apiKey: "sk-123",
      webhookUrl: "https://example.com/hook",
    };

    const result = stripDatabaseSecrets(config, "discord");

    expect(result).toBe(config);
  });

  it("handles empty config", () => {
    const result = stripDatabaseSecrets({}, "database");
    expect(result).toEqual({});
  });

  it("preserves non-secret database fields when secrets are present", () => {
    const config = {
      host: "localhost",
      password: "pass",
      sslMode: "require",
    };

    const result = stripDatabaseSecrets(config, "database");

    expect(result).toEqual({
      host: "localhost",
      sslMode: "require",
    });
  });
});

describe("mergeDatabaseConfig", () => {
  it("preserves existing secrets when incoming values are empty", () => {
    const existing = {
      host: "db.example.com",
      password: "existing-pass",
      url: "postgresql://user:existing-pass@db.example.com/mydb",
    };
    const incoming = {
      host: "new-host.com",
      password: "",
      url: "",
    };

    const result = mergeDatabaseConfig(existing, incoming);

    expect(result.host).toBe("new-host.com");
    expect(result.password).toBe("existing-pass");
    expect(result.url).toBe(
      "postgresql://user:existing-pass@db.example.com/mydb"
    );
  });

  it("preserves existing secrets when incoming values are undefined", () => {
    const existing = {
      host: "db.example.com",
      password: "existing-pass",
    };
    const incoming = {
      host: "new-host.com",
      password: undefined,
    };

    const result = mergeDatabaseConfig(existing, incoming);

    expect(result.host).toBe("new-host.com");
    expect(result.password).toBe("existing-pass");
  });

  it("overwrites secrets when incoming values are non-empty", () => {
    const existing = {
      host: "db.example.com",
      password: "old-pass",
    };
    const incoming = {
      password: "new-pass",
    };

    const result = mergeDatabaseConfig(existing, incoming);

    expect(result.host).toBe("db.example.com");
    expect(result.password).toBe("new-pass");
  });

  it("overwrites non-secret fields unconditionally", () => {
    const existing = {
      host: "old-host.com",
      port: "5432",
      password: "pass",
    };
    const incoming = {
      host: "",
      port: "5433",
    };

    const result = mergeDatabaseConfig(existing, incoming);

    expect(result.host).toBe("");
    expect(result.port).toBe("5433");
    expect(result.password).toBe("pass");
  });

  it("handles empty incoming config", () => {
    const existing = {
      host: "db.example.com",
      password: "pass",
    };

    const result = mergeDatabaseConfig(existing, {});

    expect(result).toEqual(existing);
  });

  it("does not mutate existing config", () => {
    const existing = { host: "old", password: "pass" };
    const existingCopy = { ...existing };

    mergeDatabaseConfig(existing, { host: "new" });

    expect(existing).toEqual(existingCopy);
  });
});
