/**
 * F-001: Open Dynamic Client Registration accepted arbitrary redirect_uri
 * schemes (javascript:, data:, file:, custom app schemes, non-loopback http).
 *
 * These pure tests pin the OAuth 2.1 Security BCP / RFC 8252 allowlist
 * implemented by isAllowedRedirectUri(): https for any host, plaintext http
 * only for loopback, everything else rejected.
 */
import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri } from "@/lib/mcp/redirect-uri";

describe("isAllowedRedirectUri", () => {
  const allowed = [
    "https://example.com/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:8080/cb",
    "http://127.0.0.1:1234/cb",
    "http://[::1]:9000/cb",
  ];

  const rejected = [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "intent://scan/#Intent;scheme=zxing;end",
    "vscode://anysphere/cb",
    "com.example.app:/oauth2redirect",
    "http://evil.com/cb",
    "http://169.254.169.254/cb",
    "not a url",
    "",
  ];

  for (const uri of allowed) {
    it(`allows ${uri}`, () => {
      expect(isAllowedRedirectUri(uri)).toBe(true);
    });
  }

  for (const uri of rejected) {
    it(`rejects ${JSON.stringify(uri)}`, () => {
      expect(isAllowedRedirectUri(uri)).toBe(false);
    });
  }
});
