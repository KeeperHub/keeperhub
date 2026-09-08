// Single source of truth for the user-facing rejection message when a signup
// is blocked because the email domain is in the disposable / temporary list.
// Server (lib/auth.ts databaseHooks.user.create.before) throws an APIError
// carrying this message; client (components/auth/dialog.tsx) imports the same
// constant so the surfaced text never drifts between the two sides.
//
// Kept in its own file so the client bundle does not pull in the 5,488-domain
// JSON or the Set construction from lib/auth-disposable-emails.ts.

export const DISPOSABLE_EMAIL_REJECTION_MESSAGE =
  "Disposable or temporary email addresses aren't allowed. Please use a permanent email.";
