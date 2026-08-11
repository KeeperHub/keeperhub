import { z } from "zod";

/**
 * Dynamic Client Registration body (RFC 7591) for POST /api/oauth/register.
 *
 * Validates only the fields this server consumes. Unknown fields are stripped
 * rather than rejected: standard DCR clients send many optional metadata
 * fields (client_uri, logo_uri, contacts, jwks, software_id, ...) and a strict
 * schema would reject otherwise-valid registrations. Semantic checks that the
 * schema cannot express (redirect_uri allowlist, scope normalization, grant
 * filtering) stay in the route.
 */
export const oauthRegisterSchema = z.object({
  client_name: z.string().trim().min(1, "client_name is required"),
  redirect_uris: z
    .array(z.string(), {
      error: "redirect_uris must be a non-empty array of strings",
    })
    .min(1, "redirect_uris must contain at least one URI"),
  scope: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export type OAuthRegisterInput = z.infer<typeof oauthRegisterSchema>;

/**
 * Token-endpoint params for the authorization_code grant. The handler reads
 * client_secret separately from the original request (body or Basic header),
 * so unknown params are safely stripped here.
 */
export const oauthAuthorizationCodeSchema = z.object({
  code: z.string().min(1),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_verifier: z.string().min(1),
});

export type OAuthAuthorizationCodeInput = z.infer<
  typeof oauthAuthorizationCodeSchema
>;

/** Token-endpoint params for the refresh_token grant. */
export const oauthRefreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
});

export type OAuthRefreshTokenInput = z.infer<typeof oauthRefreshTokenSchema>;
