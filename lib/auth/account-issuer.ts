// Issuer written on credential (email/password) accounts.
//
// Better Auth 1.7.0-1.7.2 matched credential sign-in on (providerId, issuer,
// accountId); 1.7.3+ ignores the column. Seeds still write it so seeded rows
// look like ones 1.7.2 created. The library derived it as
// `local:` + encodeURIComponent(providerId) in its internal
// createLocalAccountIssuer helper, which it does not export; mirrored here
// rather than reaching into @better-auth/core, which is not a direct
// dependency.
//
// Kept in its own module with no imports because the seed scripts that write
// credential rows run under tsx with their own postgres client - importing it
// from account-kind.ts would drag in the @/lib/db singleton and open a second
// pool at module load.
export const CREDENTIAL_ACCOUNT_ISSUER = "local:credential";
