/**
 * KEEP-828: OAuth route input schemas. Registration must stay lenient for
 * RFC 7591 metadata (strip, not strict) while still requiring client_name and
 * a non-empty redirect_uris; the token-grant schemas require their per-grant
 * params.
 */
import { describe, expect, it } from "vitest";
import {
  oauthAuthorizationCodeSchema,
  oauthRefreshTokenSchema,
  oauthRegisterSchema,
} from "@/lib/schemas/oauth";

describe("oauthRegisterSchema", () => {
  it("accepts a minimal DCR registration", () => {
    expect(
      oauthRegisterSchema.safeParse({
        client_name: "App",
        redirect_uris: ["https://example.com/cb"],
      }).success
    ).toBe(true);
  });

  it("keeps unknown RFC 7591 metadata fields (strip, not strict)", () => {
    expect(
      oauthRegisterSchema.safeParse({
        client_name: "App",
        redirect_uris: ["https://example.com/cb"],
        logo_uri: "https://example.com/logo.png",
        contacts: ["dev@example.com"],
      }).success
    ).toBe(true);
  });

  it("rejects an empty client_name", () => {
    expect(
      oauthRegisterSchema.safeParse({
        client_name: "   ",
        redirect_uris: ["https://example.com/cb"],
      }).success
    ).toBe(false);
  });

  it("rejects an empty redirect_uris array", () => {
    expect(
      oauthRegisterSchema.safeParse({ client_name: "App", redirect_uris: [] })
        .success
    ).toBe(false);
  });
});

describe("oauth token-grant param schemas", () => {
  it("authorization_code requires the full PKCE param set", () => {
    expect(
      oauthAuthorizationCodeSchema.safeParse({
        code: "c",
        client_id: "i",
        redirect_uri: "https://example.com/cb",
        code_verifier: "v",
      }).success
    ).toBe(true);
    expect(
      oauthAuthorizationCodeSchema.safeParse({ code: "c", client_id: "i" })
        .success
    ).toBe(false);
  });

  it("refresh_token requires refresh_token and client_id", () => {
    expect(
      oauthRefreshTokenSchema.safeParse({
        refresh_token: "t",
        client_id: "i",
      }).success
    ).toBe(true);
    expect(oauthRefreshTokenSchema.safeParse({ client_id: "i" }).success).toBe(
      false
    );
  });
});
