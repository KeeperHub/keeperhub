# Organization Invitation E2E Test Cases

## 1. Invitation Flows

### 1.1 Sending Invites

| ID | Test Case | Expected Outcome |
|----|-----------|-------------------|
| INV-SEND-1 | Invite new email (not in system) | toast.success "Invitation sent to {email}". Invite link/code copy buttons appear. |
| INV-SEND-2 | Invite existing user (already has account) | toast.success "Invitation sent to {email}". Invite link/code copy buttons appear. |
| INV-SEND-3 | Invite email that already has a pending invitation | toast.error "User is already invited to this organization" (from Better Auth server response). |
| INV-SEND-4 | Invite yourself | toast.error "User is already a member of this organization" (from Better Auth server response). |

### 1.2 Receiving Invites

| ID | Test Case | Expected Outcome |
|----|-----------|-------------------|
| INV-RECV-1 | Accept invite as logged-out new user | AuthFormState in signup mode. On submit: toast.success "Account created! Please check your email for a verification code.", transitions to VerificationFormState. On valid OTP: verifies email, signs in, accepts invitation, toast.success "Welcome to {organizationName}!", redirects to /workflows. On invalid OTP: form error with server message or "Invalid verification code". |
| INV-RECV-2 | Accept invite as logged-out existing user | AuthFormState in signin mode. On correct password (verified email): accepts invitation, toast.success "Welcome to {organizationName}!", redirects to /workflows. On correct password (unverified email): toast.info "Please verify your email. A new code has been sent.", transitions to VerificationFormState (same OTP flow as INV-RECV-1). On wrong password: form error "Incorrect password. Please try again." |
| INV-RECV-3 | Accept invite while logged in as the correct user | Shows AcceptDirectState: heading "Join {organizationName}", "You're signed in as {email}", button "Accept Invitation". On click: toast.success "Welcome to {organizationName}!", redirects to /workflows. On error: form error with server message or "Failed to accept invitation". |
| INV-RECV-4 | Accept invite while logged in as a different user | Shows EmailMismatchState: amber warning icon, heading "Wrong Account", "This invitation is for {inviteEmail}", "You're currently signed in as {currentEmail}". Button "Sign Out & Continue": signs out, page reloads as logged-out user showing AuthFormState. Button "Go Back": navigates to /workflows. |

---

## 2. Organization Membership

### 2.1 Multi-Org Scenarios

| ID | Test Case | Expected Outcome |
|----|-----------|-------------------|
| ORG-1 | User belongs to multiple orgs - can switch between them | Org switcher button shows current org name with Users icon. Clicking opens popover listing all orgs with checkmark on active org. Selecting an org calls switchOrganization, sets it active, page refreshes. "Manage Organizations" option at bottom opens manage modal. |
| ORG-2 | User accepts invite to second org while in first org | Same flow as INV-RECV-3 (AcceptDirectState). After acceptance, new org appears in org switcher dropdown. toast.success "Welcome to {organizationName}!", redirects to /workflows. |
| ORG-3 | User leaves an org | In manage orgs modal, "Leave Organization" button (orange). Confirmation dialog: title "Leave Organization", description "Are you sure you want to leave {orgName}? You will need a new invitation to rejoin." On confirm: toast.success "Left {orgName}". If it was the active org, auto-switches to another org if available. On error: toast.error with server message or "Failed to leave organization". |
| ORG-4 | User removed from org by admin - next page load behavior | Admin side: trash icon per member (except self). Confirmation dialog: title "Remove Member", description "Are you sure you want to remove {memberName} from this organization? This action cannot be undone." Buttons: "Cancel" and "Remove" (destructive). On confirm: calls removeMember, refreshes member list. No toast. Removed user side: no in-app notification. Session still has activeOrganizationId pointing to that org, next org-context API call would fail. |