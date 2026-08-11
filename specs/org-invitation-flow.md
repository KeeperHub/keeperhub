# Organization Invitation Flow

## Current Implementation Analysis

### Scenario 1: Non-registered email invited (not logged in)

**Current:** Shows "Create Account & Join" → user creates password → signup → signin → accept
**Status:** ✅ Works fine

### Scenario 2: Existing user invited (not logged in)

**Current:** Shows auth form with sign-in/sign-up toggle. Users can choose to sign in directly if they already have an account.
**Status:** ✅ Implemented - toggle between "Sign in" and "Create account" at bottom of form

### Scenario 3: Existing user opens link while already logged in

**Current:** Shows "Accept Invitation" button directly with no password required. Displays "You're signed in as [email]" confirmation.
**Status:** ✅ Implemented - `AcceptDirectState` component

### Scenario 4: User opens link but logged in as a different user

**Current:** Shows "Wrong Account" warning with:
- "This invitation is for [invited@email.com]"
- "You're currently signed in as [current@email.com]"
- "Sign Out & Continue" button
- "Go Back" button
**Status:** ✅ Implemented - `EmailMismatchState` component

---

## Implementation Details

### Page States
The accept-invite page now uses a state machine approach with these states:
- `loading` - Fetching invitation and session data
- `error` - Invalid/expired invitation
- `not-found` - Invitation doesn't exist
- `logged-in-match` - User logged in with correct email
- `logged-in-mismatch` - User logged in with different email
- `logged-out` - User not logged in

### Components
1. **AcceptDirectState** - For logged-in users with matching email (single "Accept" button)
2. **EmailMismatchState** - For logged-in users with wrong email (sign out option)
3. **AuthFormState** - For logged-out users with sign-in/sign-up toggle

### Session Detection
Uses `useSession()` hook from better-auth to detect:
- Whether user is logged in
- Whether user is anonymous (temp email or "Anonymous" name)
- Current user's email for comparison with invitation email
