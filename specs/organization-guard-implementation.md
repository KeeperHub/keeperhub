# Organization Guard Implementation Plan (Auto-Create Approach)

## Strategy: Auto-Create + Edge Case Guards

With automatic organization creation, **every user gets a personal organization on signup**. Guards are now mainly for:
- Edge cases (org creation failure, org deletion)
- Backend API protection
- Clear error states

Most users will **always** have an organization.

### What Changed from Original Plan

**Old Approach (Manual Setup):**
- Sign up → Page reload → Detect no org → Redirect to `/onboarding/organization` → User fills form → Create org → Redirect to dashboard
- Complex redirect flow, modal state issues, edge cases to handle

**New Approach (Auto-Create):**
- Sign up → Server creates org automatically → Page reload → User ready to work
- Simple, reliable, matches industry standard

**Result:** Simpler code, better UX, fewer edge cases.

---

## How It Works

### Sign-up Flow (Automatic)
```
1. User clicks "Sign Up" (modal)
2. User enters email/password
3. User clicks "Create account"
4. better-auth creates account
5. ✨ afterSignUp hook automatically creates personal org
6. Org is set as active
7. User is signed in with org ready
8. Page reloads → User can start working immediately
```

### Edge Case: Org Creation Failure
```
1. User signs up
2. Org creation fails (network, DB error, etc.)
3. User is logged in BUT has no org
4. useRequireOrganization hook detects this (edge case)
5. Show error: "Organization setup failed. Please contact support."
```

### Edge Case: Org Deleted
```
1. User's organization is deleted (by owner, admin action, etc.)
2. User still logged in but org no longer exists
3. useRequireOrganization hook detects missing org
4. Show error: "Organization not found. Create or join another."
```

### Protected Resource Flow (Backend)
```
1. User tries to create workflow
2. Backend checks org membership
3. No org? Return 403 error
4. Frontend shows: "Organization required to perform this action"
```

---

## Implementation Steps

### Step 1: Implement Auto-Create Hook ⭐ **CRITICAL**
**File**: `lib/auth.ts`

Add `afterSignUp` hook to organization plugin configuration:

```typescript
organization({
  // ... existing config ...

  organizationHooks: {
    // AUTO-CREATE: Create personal organization for new users
    async afterSignUp({ user }) {
      const { nanoid } = await import("nanoid");

      // Generate unique slug from user name/email
      const baseName = user.name || user.email?.split("@")[0] || "User";
      const slug = `${baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${nanoid(6)}`;

      console.log(`[Auto-Create] Creating organization for new user ${user.email}`);

      try {
        // Create organization
        const org = await auth.api.createOrganization({
          name: `${baseName}'s Organization`,
          slug,
          userId: user.id,
        });

        // Set as active organization
        await auth.api.setActiveOrganization({
          userId: user.id,
          organizationId: org.id,
        });

        console.log(`[Auto-Create] Organization "${org.name}" created for ${user.email}`);
      } catch (error) {
        console.error(`[Auto-Create] Failed to create org for ${user.email}:`, error);
        // User is still signed up, but without org (edge case - will be caught by guards)
      }
    },

    // ... other hooks (afterCreateOrganization, etc.)
  }
})
```

---

### Step 2: Clean Up Sign-up Modal (Optional)
**File**: `components/auth/dialog.tsx`

Since orgs are auto-created, remove the org-setup flow from the sign-up modal:

```typescript
// Remove these (search for "keeperhub" markers):
// - "org-setup" from ModalView type
// - OrgSetupView component
// - handleOrgSetupComplete function
// - org-setup view rendering in the modal
// - Modified handleCheckEmailAndSignUp logic (revert to original)
```

The modal should just handle sign-up. Organization is created server-side automatically.

---

### Step 3: Backend API Guards ⭐ **IMPORTANT**

**Apply `requireOrganization` middleware to APIs:**

**Example**: `/app/api/workflows/route.ts`

```typescript
import { requireOrganization } from "@/keeperhub/lib/middleware/require-org";

async function handlePost(req: NextRequest, context: any) {
  // context.organization is guaranteed to exist here
  // context.member has user's role

  // ... workflow creation logic ...
}

export const POST = requireOrganization(handlePost);
```

**Apply to:**
- `/app/api/workflows/*`
- `/app/api/integrations/*`
- `/app/api/user/wallet` (if exists)
- Any other endpoints that require org context

---

### Step 4: Client-Side Edge Case Guard (Optional - Defensive)

**File**: `keeperhub/lib/hooks/use-require-organization.ts`

For rare edge cases where org creation fails:

```typescript
"use client";

import { useEffect } from "react";
import { useOrganization } from "./use-organization";
import { useSession } from "@/lib/auth-client";
import { toast } from "sonner";

export function useRequireOrganization() {
  const { organization, isLoading: orgLoading } = useOrganization();
  const { data: session, isPending: sessionLoading } = useSession();

  useEffect(() => {
    if (sessionLoading || orgLoading) return;

    // Edge case: Authenticated user without organization
    if (session?.user && !organization) {
      toast.error("Organization setup failed. Please contact support.", {
        duration: Infinity, // Don't auto-dismiss
      });
      console.error("[Edge Case] User without organization:", session.user.email);
    }
  }, [session, organization, sessionLoading, orgLoading]);

  return {
    organization,
    isLoading: orgLoading || sessionLoading,
    hasOrg: !!organization,
  };
}
```

**Apply to protected pages** (optional, for clear error states):

```tsx
"use client";

import { useRequireOrganization } from "@/keeperhub/lib/hooks/use-require-organization";

export default function DashboardPage() {
  const { organization, isLoading } = useRequireOrganization();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  // This should rarely/never happen with auto-create
  if (!organization) {
    return (
      <div className="p-8 text-center">
        <h2>Organization Not Found</h2>
        <p>Please contact support for assistance.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Dashboard - {organization.name}</h1>
      {/* ... */}
    </div>
  );
}
```

---

## Testing Checklist

### Scenario 1: New User Sign-up (Auto-Create)
- [ ] Click "Sign Up" in modal
- [ ] Enter email/password, submit
- [ ] **Expect**: Page reloads
- [ ] **Expect**: User is signed in
- [ ] **Expect**: Organization automatically created (check console logs)
- [ ] **Expect**: Org switcher shows org name (e.g., "John's Organization")
- [ ] **Expect**: Can immediately create workflows

### Scenario 2: Check Database
- [ ] Sign up a new user
- [ ] Check `organization` table → new org exists
- [ ] Check `member` table → user is owner of org
- [ ] Check `session` table → `activeOrganizationId` is set

### Scenario 3: Social Auth (GitHub/Google)
- [ ] Sign up via GitHub/Google
- [ ] **Expect**: Organization auto-created
- [ ] **Expect**: Org name based on GitHub/Google name
- [ ] **Expect**: User can start working immediately

### Scenario 4: API Protection (Backend Guards)
- [ ] Manually delete user's org from database (simulate edge case)
- [ ] Try to call `POST /api/workflows`
- [ ] **Expect**: 403 error with message about org required

### Scenario 5: Edge Case - Org Creation Fails
- [ ] Temporarily break DB connection during signup (or simulate error)
- [ ] Sign up
- [ ] **Expect**: User is signed in but has no org
- [ ] **Expect**: Toast error shows: "Organization setup failed"
- [ ] **Expect**: Protected pages show error state

### Scenario 6: Anonymous User (Unchanged)
- [ ] Open app (not logged in)
- [ ] Navigate to `/workflows`
- [ ] **Expect**: Works (anonymous mode)
- [ ] Try to save workflow
- [ ] **Expect**: Prompted to sign up

### Scenario 7: Multi-Organization Switching
- [ ] Sign up as User A (gets personal org)
- [ ] User B invites User A to their org
- [ ] User A accepts invitation
- [ ] **Expect**: User A now has 2 orgs in org switcher
- [ ] Switch between orgs
- [ ] **Expect**: Both orgs work correctly

---

## Implementation Order

### Phase 1: Core Auto-Create (Critical)
1. ⭐ **Implement auto-create hook in `lib/auth.ts`** (Step 1)
2. **Test sign-up flow** → Verify org created automatically
3. **Clean up sign-up modal** → Remove org-setup view code (Step 2)

### Phase 2: Backend Protection (Important)
4. **Apply `requireOrganization` to workflow APIs** (Step 3)
5. **Apply `requireOrganization` to credential APIs** (Step 3)
6. **Test API guards** → 403 without org

### Phase 3: Edge Case Handling (Optional - Can defer)
7. **Create `useRequireOrganization` hook** (Step 4)
8. **Apply to protected pages for better UX** (Step 4)
9. **Test edge cases** → Simulate org creation failure

---

## Benefits of Auto-Create Approach

✅ **Simplest UX possible** - Sign up → Start working (no extra steps)
✅ **No edge cases** - Every user always has an org
✅ **Reliable** - Server-side, atomic with signup
✅ **Standard SaaS pattern** - Used by Slack, GitHub, Notion
✅ **No redirect complexity** - No modal state management
✅ **Fast onboarding** - Zero friction for new users
✅ **Easy to test** - Deterministic, predictable behavior
✅ **Future-proof** - Works with any auth provider (email, social, etc.)
