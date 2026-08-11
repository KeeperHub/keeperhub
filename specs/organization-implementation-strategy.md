# Organization Implementation Strategy (Using Better-Auth)

## Overview

This document outlines the technical implementation strategy for adding multi-organization support using **better-auth's native organization plugin**. This approach leverages battle-tested authentication infrastructure rather than building from scratch.

**Key Benefits:**
- Built-in RBAC (Owner/Admin/Member roles)
- Native invitation system with email support
- Session-based active organization tracking
- Hooks for custom business logic
- Database schema managed by better-auth migrations
- **Automatic organization creation** on user signup

**User Flows:**
1. **New User Signup** → Auto-create personal organization → Start using app immediately
2. **Invitation Flow** → User receives invite → Joins existing organization
3. **Multi-Org Users** → Switch between organizations via dropdown

All custom code follows the KeeperHub fork policy (everything in `/keeperhub` directory).

---

## 🎯 Auto-Create Implementation Summary

**Key Decision: Automatic Organization Creation**

Instead of requiring users to manually set up an organization during sign-up, we automatically create a personal organization for every new user. This simplifies the onboarding flow and matches standard SaaS patterns (Slack, GitHub, Notion).

**Implementation:**
- Server-side hook: `afterSignUp` in better-auth organization plugin
- Creates `"{Name}'s Organization"` with unique slug
- Sets as active organization automatically
- User starts with full access (owner role)

**Benefits:**
- ✅ Simple UX: Sign up → Start using immediately
- ✅ No edge cases: Every user always has an org
- ✅ No modal/redirect complexity
- ✅ Reliable: Server-side, atomic with signup

**User can still:**
- Create additional organizations later
- Join other organizations via invitation
- Rename/customize their auto-created organization

---

## Phase 1: Enable Organization Plugin **(implemented)**

### Server Configuration **(implemented)**

**`lib/auth.ts`** (Modify with markers)

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
// start custom keeperhub code //
import { anonymous, genericOAuth, organization } from "better-auth/plugins";
// end keeperhub code //
import { db } from "./db";

// start custom keeperhub code //
// Define custom access control for organization resources
import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"], // Wallet
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
} as const;

const ac = createAccessControl(statement);

// Define role permissions aligned with requirements
const memberRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["read"],
  wallet: ["read"], // Can use wallet, not manage
  organization: ["read"],
  member: ["read"],
});

const adminRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"], // Can manage wallets
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

const ownerRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});
// end keeperhub code //

const plugins = [
  anonymous({
    async onLinkAccount(data) {
      // start custom keeperhub code //
      // When anonymous user links account, DELETE their trial workflows
      // (Anonymous workflows have no real utility in org context)
      const fromUserId = data.anonymousUser.user.id;
      const toUserId = data.newUser.user.id;

      console.log(
        `[Anonymous Migration] Deleting trial workflows for user ${fromUserId}`
      );

      try {
        // Delete anonymous workflows (not migrated per requirements)
        await db.delete(workflows).where(eq(workflows.userId, fromUserId));

        console.log(
          `[Anonymous Migration] Trial workflows deleted. User ${toUserId} starts fresh.`
        );
      } catch (error) {
        console.error("[Anonymous Migration] Error:", error);
        throw error;
      }
      // end keeperhub code //
    },
  }),
  // start custom keeperhub code //
  organization({
    // Access control with custom roles
    ac,
    roles: {
      owner: ownerRole,
      admin: adminRole,
      member: memberRole,
    },

    // Email invitation handler (integrate with SendGrid plugin)
    async sendInvitationEmail(data) {
      const inviteLink = `${process.env.NEXT_PUBLIC_APP_URL}/accept-invite/${data.id}`;

      // TODO: Use SendGrid plugin to send email
      // For now, log the invite (email integration in Phase 7)
      console.log(`[Invitation] Sending to ${data.email}`, {
        inviter: data.inviter.user.name,
        organization: data.organization.name,
        role: data.role,
        link: inviteLink,
      });

      // await sendEmail({
      //   to: data.email,
      //   template: "organization-invitation",
      //   data: {
      //     inviterName: data.inviter.user.name,
      //     organizationName: data.organization.name,
      //     role: data.role,
      //     inviteLink,
      //   },
      // });
    },

    // Invitation settings
    invitationExpiresIn: 7 * 24 * 60 * 60, // 7 days
    cancelPendingInvitationsOnReInvite: true,

    // Hooks for custom business logic
    organizationHooks: {
      // AUTO-CREATE: Create personal organization for new users
      async afterSignUp({ user }) {
        // Generate unique slug from user name/email
        const baseName = user.name || user.email?.split("@")[0] || "User";
        const slug = `${baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${nanoid(6)}`;

        console.log(`[Auto-Create] Creating organization for new user ${user.email}`);

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

        console.log(`[Auto-Create] Organization "${org.name}" created and set as active for ${user.email}`);
      },

      async afterCreateOrganization({ organization, member, user }) {
        console.log(`[Organization] Created: ${organization.name} by ${user.name}`);
        // Note: This runs for both auto-created AND manually created orgs
        // TODO: Initialize default resources (e.g., welcome workflow template)
      },

      async afterAddMember({ member, user, organization }) {
        console.log(`[Organization] User ${user.email} joined ${organization.name}`);
      },

      async beforeRemoveMember({ member, user, organization }) {
        // Prevent removing the last owner
        const owners = await db.query.members.findMany({
          where: and(
            eq(members.organizationId, organization.id),
            eq(members.role, "owner")
          ),
        });

        if (owners.length === 1 && owners[0].id === member.id) {
          throw new APIError("BAD_REQUEST", {
            message: "Cannot remove the last owner. Transfer ownership first.",
          });
        }
      },

      async afterAcceptInvitation({ invitation, member, user, organization }) {
        // Set the newly joined org as active
        // Better-auth handles this automatically, but we can add custom logic
        console.log(`[Invitation] ${user.email} accepted invite to ${organization.name}`);
      },
    },
  }),
  // end keeperhub code //
];

export const auth = betterAuth({
  baseURL: getBaseURL(),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  // ... rest of existing config
  plugins,
});
```

### Client Configuration **(implemented)**

**`lib/auth-client.ts`** (Modify with markers)

```typescript
import { anonymousClient } from "better-auth/client/plugins";
// start custom keeperhub code //
import { organizationClient } from "better-auth/client/plugins";
// end keeperhub code //
import { createAuthClient } from "better-auth/react";

// start custom keeperhub code //
// Import the same access control definition (shared type safety)
import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
} as const;

const ac = createAccessControl(statement);

const memberRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["read"],
  wallet: ["read"],
  organization: ["read"],
  member: ["read"],
});

const adminRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

const ownerRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});
// end keeperhub code //

export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000",
  plugins: [
    anonymousClient(),
    // start custom keeperhub code //
    organizationClient({
      ac,
      roles: {
        owner: ownerRole,
        admin: adminRole,
        member: memberRole,
      },
    }),
    // end keeperhub code //
  ],
});

export const { signIn, signOut, signUp, useSession } = authClient;
```

### Database Migration **(implemented)**

**Step 1: Generate organization schema**

```bash
# Generate schema (for Drizzle adapter) - creates auth-schema.ts
npx @better-auth/cli generate
```

**Note:** The `migrate` command only works with Kysely adapter. Since we use Drizzle, we use `generate` then manually integrate.

**Step 2: Integrate organization tables into existing schema**

The generated `auth-schema.ts` contains organization tables. Since we already have Better Auth tables in `lib/db/schema.ts`, we need to:

1. Add organization tables from `auth-schema.ts` to `lib/db/schema.ts` with keeperhub markers
2. Add `activeOrganizationId` field to existing `sessions` table
3. Export organization tables and relations

Tables to add:
- `organization` - Organization records (id, name, slug, logo, metadata)
- `member` - User-organization memberships with roles
- `invitation` - Pending invitations (email, role, status, expiresAt)

**Step 3: Push schema to database**

```bash
pnpm db:push
```

This applies all changes to the database.

---

## Phase 2: Workflow & Credential Scoping **(implemented)**

### Update Database Schema **(implemented)**

**`lib/db/schema.ts`** (Modify with markers)

```typescript
// start custom keeperhub code //
export const workflows = pgTable("workflows", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .references(() => organization.id, { onDelete: "cascade" })
    .notNull(), // Required for authenticated workflows
  isAnonymous: boolean("is_anonymous").default(false).notNull(),
  // ... existing columns
});

export const integrations = pgTable("integrations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .references(() => organization.id, { onDelete: "cascade" }),
  // ... existing columns
});
// end keeperhub code //
```

**Migration Strategy:**

1. Add `organizationId` as nullable initially
2. Backfill existing data:
   ```sql
   -- Create a "Personal" org for each user
   -- Assign all their workflows to that org
   -- (See migration script in Phase 8)
   ```
3. Make `organizationId` required after backfill

### Organization Context Middleware **(implemented)**

**`keeperhub/lib/middleware/org-context.ts`**

```typescript
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export interface OrgContext {
  user: any | null;
  organization: any | null;
  member: any | null;
  isAnonymous: boolean;
  needsOrganization: boolean;
}

export async function getOrgContext(req?: NextRequest): Promise<OrgContext> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return {
      user: null,
      organization: null,
      member: null,
      isAnonymous: true,
      needsOrganization: false,
    };
  }

  const activeOrgId = session.session.activeOrganizationId;

  if (!activeOrgId) {
    // Authenticated user without active organization
    return {
      user: session.user,
      organization: null,
      member: null,
      isAnonymous: false,
      needsOrganization: true,
    };
  }

  // Get full organization details
  const orgData = await auth.api.getFullOrganization({
    headers: await headers(),
    query: { organizationId: activeOrgId },
  });

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });

  return {
    user: session.user,
    organization: orgData?.organization || null,
    member: activeMember || null,
    isAnonymous: false,
    needsOrganization: !orgData,
  };
}

// Permission helper
export async function hasPermission(
  resource: string,
  actions: string[]
): Promise<boolean> {
  const result = await auth.api.hasPermission({
    headers: await headers(),
    body: {
      permissions: {
        [resource]: actions,
      },
    },
  });

  return result?.success || false;
}
```

### Protected Route Wrapper **(implemented)**

**`keeperhub/lib/middleware/require-org.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getOrgContext } from "./org-context";

export function requireOrganization(
  handler: (req: NextRequest, context: any) => Promise<Response>
) {
  return async (req: NextRequest) => {
    const context = await getOrgContext(req);

    if (context.isAnonymous) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    if (context.needsOrganization) {
      return NextResponse.json(
        { error: "You must create or join an organization" },
        { status: 403 }
      );
    }

    return handler(req, context);
  };
}

// Permission-based wrappers
export function requirePermission(
  resource: string,
  actions: string[],
  handler: (req: NextRequest, context: any) => Promise<Response>
) {
  return requireOrganization(async (req, context) => {
    const canPerform = await hasPermission(resource, actions);

    if (!canPerform) {
      return NextResponse.json(
        { error: `Missing permission: ${resource}:${actions.join(",")}` },
        { status: 403 }
      );
    }

    return handler(req, context);
  });
}
```

---

## Phase 3: UI Components

### Organization Context Hooks

**`keeperhub/lib/hooks/use-organization.ts`**

```typescript
"use client";

import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export function useOrganization() {
  const { data: activeOrg, isPending, error } = authClient.useActiveOrganization();
  const router = useRouter();

  const switchOrganization = async (orgId: string) => {
    await authClient.organization.setActive({ organizationId: orgId });
    router.refresh();
  };

  return {
    organization: activeOrg,
    isLoading: isPending,
    error,
    switchOrganization,
  };
}

export function useOrganizations() {
  const { data: orgs, isPending } = authClient.useListOrganizations();

  return {
    organizations: orgs || [],
    isLoading: isPending,
  };
}

export function useActiveMember() {
  const { data: member, isPending } = authClient.organization.useActiveMember();

  return {
    member,
    isLoading: isPending,
    role: member?.role,
    isOwner: member?.role === "owner",
    isAdmin: member?.role === "admin" || member?.role === "owner",
  };
}

export function usePermissions() {
  const checkPermission = async (resource: string, actions: string[]) => {
    const result = await authClient.organization.hasPermission({
      permissions: { [resource]: actions },
    });
    return result?.success || false;
  };

  const checkLocalPermission = (
    role: string,
    resource: string,
    actions: string[]
  ) => {
    return authClient.organization.checkRolePermission({
      role,
      permissions: { [resource]: actions },
    });
  };

  return {
    checkPermission,
    checkLocalPermission,
  };
}
```

### Organization Creation Modal (Optional - For Additional Orgs)

**Note:** With auto-create, new users get a personal organization automatically. This component is **optional** and used for:
- Creating additional organizations (from org switcher)
- Accepting invitations to join existing organizations

**`keeperhub/components/organization/create-org-modal.tsx`**

```tsx
"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function OrganizationSetup() {
  const router = useRouter();
  const [mode, setMode] = useState<"choice" | "create" | "join">("choice");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Auto-generate slug from name
  const handleNameChange = (value: string) => {
    setName(value);
    if (!slug) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    }
  };

  const handleCreate = async () => {
    setLoading(true);
    setError("");

    try {
      const { data, error: createError } = await authClient.organization.create({
        name,
        slug,
      });

      if (createError) {
        setError(createError.message || "Failed to create organization");
        return;
      }

      // Set as active organization
      await authClient.organization.setActive({
        organizationId: data.organization.id,
      });

      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    setLoading(true);
    setError("");

    try {
      // Get invitation details
      const { data: invite } = await authClient.organization.getInvitation({
        id: inviteCode,
      });

      if (!invite) {
        setError("Invalid or expired invitation code");
        return;
      }

      // Accept invitation
      const { error: acceptError } = await authClient.organization.acceptInvitation({
        invitationId: inviteCode,
      });

      if (acceptError) {
        setError(acceptError.message || "Failed to accept invitation");
        return;
      }

      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (mode === "choice") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-[400px]">
          <CardHeader>
            <CardTitle>Welcome!</CardTitle>
            <CardDescription>
              To continue, create a new organization or join an existing one.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              onClick={() => setMode("create")}
              className="w-full"
              size="lg"
            >
              Create Organization
            </Button>
            <Button
              onClick={() => setMode("join")}
              variant="outline"
              className="w-full"
              size="lg"
            >
              Join Organization
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode === "create") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-[400px]">
          <CardHeader>
            <CardTitle>Create Organization</CardTitle>
            <CardDescription>
              Set up a new organization for your team.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Organization Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Acme Inc."
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug (URL identifier)</Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="acme-inc"
                disabled={loading}
              />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2">
              <Button
                onClick={() => setMode("choice")}
                variant="outline"
                className="flex-1"
                disabled={loading}
              >
                Back
              </Button>
              <Button
                onClick={handleCreate}
                className="flex-1"
                disabled={loading || !name || !slug}
              >
                {loading ? "Creating..." : "Create"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // mode === "join"
  return (
    <div className="flex items-center justify-center min-h-screen">
      <Card className="w-[400px]">
        <CardHeader>
          <CardTitle>Join Organization</CardTitle>
          <CardDescription>
            Enter the invitation code you received.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">Invitation Code</Label>
            <Input
              id="code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="abc123xyz"
              disabled={loading}
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-2">
            <Button
              onClick={() => setMode("choice")}
              variant="outline"
              className="flex-1"
              disabled={loading}
            >
              Back
            </Button>
            <Button
              onClick={handleJoin}
              className="flex-1"
              disabled={loading || !inviteCode}
            >
              {loading ? "Joining..." : "Join"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

### Organization Switcher

**`keeperhub/components/organization/org-switcher.tsx`**

```tsx
"use client";

import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useOrganization, useOrganizations } from "@/keeperhub/lib/hooks/use-organization";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function OrgSwitcher() {
  const { organization, switchOrganization } = useOrganization();
  const { organizations } = useOrganizations();
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (!organization) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[200px] justify-between"
        >
          <span className="truncate">{organization.name}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0">
        <Command>
          <CommandInput placeholder="Search organizations..." />
          <CommandList>
            <CommandEmpty>No organization found.</CommandEmpty>
            <CommandGroup>
              {organizations.map((org) => (
                <CommandItem
                  key={org.id}
                  onSelect={async () => {
                    await switchOrganization(org.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={`mr-2 h-4 w-4 ${
                      organization.id === org.id ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  {org.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  router.push("/onboarding/create-organization");
                  setOpen(false);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Organization
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

### Member Management

**`keeperhub/components/organization/members-list.tsx`**

```tsx
"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useActiveMember } from "@/keeperhub/lib/hooks/use-organization";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";

interface Member {
  id: string;
  user: {
    name: string;
    email: string;
    image?: string;
  };
  role: string;
  createdAt: Date;
}

interface MembersListProps {
  members: Member[];
  onUpdate: () => void;
}

export function MembersList({ members, onUpdate }: MembersListProps) {
  const { isAdmin, member: currentMember } = useActiveMember();
  const [updating, setUpdating] = useState<string | null>(null);

  const handleRoleChange = async (memberId: string, newRole: string) => {
    setUpdating(memberId);
    try {
      await authClient.organization.updateMemberRole({
        memberId,
        role: newRole,
      });
      onUpdate();
    } catch (error) {
      console.error("Failed to update role:", error);
    } finally {
      setUpdating(null);
    }
  };

  const handleRemove = async (memberId: string, email: string) => {
    try {
      await authClient.organization.removeMember({
        memberIdOrEmail: email,
      });
      onUpdate();
    } catch (error) {
      console.error("Failed to remove member:", error);
    }
  };

  if (!isAdmin) {
    return (
      <div className="text-sm text-muted-foreground">
        Only admins and owners can manage members.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.id}>
            <TableCell>
              <div className="flex items-center gap-2">
                {member.user.image && (
                  <img
                    src={member.user.image}
                    alt={member.user.name}
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <div>
                  <div className="font-medium">{member.user.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {member.user.email}
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell>
              <Select
                value={member.role}
                onValueChange={(role) => handleRoleChange(member.id, role)}
                disabled={
                  !isAdmin ||
                  member.id === currentMember?.id ||
                  updating === member.id
                }
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell>
              {new Date(member.createdAt).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-right">
              {member.id !== currentMember?.id && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove Member</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to remove {member.user.name} from
                        this organization? This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleRemove(member.id, member.user.email)}
                        className="bg-destructive text-destructive-foreground"
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

### Invite Modal

**`keeperhub/components/organization/invite-modal.tsx`**

```tsx
"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy, Mail, UserPlus } from "lucide-react";
import { toast } from "sonner";

export function InviteModal() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [loading, setLoading] = useState(false);
  const [inviteId, setInviteId] = useState<string | null>(null);

  const handleInvite = async () => {
    setLoading(true);
    try {
      const { data, error } = await authClient.organization.inviteMember({
        email,
        role,
      });

      if (error) {
        toast.error(error.message || "Failed to send invitation");
        return;
      }

      setInviteId(data.id);
      toast.success(`Invitation sent to ${email}`);
      setEmail("");
    } catch (err: any) {
      toast.error(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const copyInviteLink = () => {
    if (!inviteId) return;
    const link = `${window.location.origin}/accept-invite/${inviteId}`;
    navigator.clipboard.writeText(link);
    toast.success("Invite link copied to clipboard");
  };

  const copyInviteCode = () => {
    if (!inviteId) return;
    navigator.clipboard.writeText(inviteId);
    toast.success("Invite code copied to clipboard");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite Member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
          <DialogDescription>
            Send an invitation to join this organization.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              disabled={loading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={(v: any) => setRole(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">
                  Member - Can create workflows
                </SelectItem>
                <SelectItem value="admin">
                  Admin - Can manage members and wallets
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {inviteId && (
            <div className="space-y-2 p-4 border rounded-lg bg-muted">
              <p className="text-sm font-medium">Invitation Created</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyInviteLink}
                  className="flex-1"
                >
                  <Copy className="mr-2 h-3 w-3" />
                  Copy Link
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyInviteCode}
                  className="flex-1"
                >
                  <Copy className="mr-2 h-3 w-3" />
                  Copy Code
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            onClick={handleInvite}
            disabled={loading || !email}
          >
            <Mail className="mr-2 h-4 w-4" />
            {loading ? "Sending..." : "Send Invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Phase 4: Navigation Guards

### Client-Side Guard Hook

**`keeperhub/lib/hooks/use-require-organization.ts`**

```typescript
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOrganization } from "./use-organization";
import { useSession } from "@/lib/auth-client";

export function useRequireOrganization() {
  const { organization, isLoading: orgLoading } = useOrganization();
  const { data: session, isPending: sessionLoading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (sessionLoading || orgLoading) return;

    // Authenticated user without organization
    if (session?.user && !organization) {
      router.push("/onboarding/organization");
    }
  }, [session, organization, sessionLoading, orgLoading, router]);

  return {
    organization,
    isLoading: orgLoading || sessionLoading,
    needsSetup: !!(session?.user && !organization),
  };
}
```

### Apply to Protected Pages

**Example: `app/dashboard/page.tsx`** (Modify with markers)

```tsx
// start custom keeperhub code //
import { useRequireOrganization } from "@/keeperhub/lib/hooks/use-require-organization";
// end keeperhub code //

export default function DashboardPage() {
  // start custom keeperhub code //
  const { organization, isLoading } = useRequireOrganization();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!organization) {
    return null; // Redirecting...
  }
  // end keeperhub code //

  return (
    <div>
      <h1>Dashboard - {organization.name}</h1>
      {/* ... */}
    </div>
  );
}
```

---

## Phase 5: Wallet Organization Integration

### Modify Wallet Credential Form

**`keeperhub/plugins/web3/credentials.tsx`** (or relevant file)

```tsx
// start custom keeperhub code //
import { useActiveMember } from "@/keeperhub/lib/hooks/use-organization";
import { Alert, AlertDescription } from "@/components/ui/alert";
// end keeperhub code //

export function WalletCredentialForm() {
  // start custom keeperhub code //
  const { isAdmin } = useActiveMember();

  if (!isAdmin) {
    return (
      <Alert>
        <AlertDescription>
          Only organization owners and admins can manage wallets.
        </AlertDescription>
      </Alert>
    );
  }
  // end keeperhub code //

  return (
    <Form>
      {/* start custom keeperhub code // */}
      <Input
        name="email"
        label="Wallet Email"
        placeholder="treasury@company.com"
        description="Choose an email for this organization's wallet (not your personal email)"
      />
      {/* end keeperhub code // */}
      {/* ... rest of form */}
    </Form>
  );
}
```

### Scope Credentials by Organization

When querying credentials, filter by active org:

```typescript
// In credential queries
// start custom keeperhub code //
const credentials = await db.query.integrations.findMany({
  where: and(
    eq(integrations.organizationId, activeOrgId),
    // ... other filters
  ),
});
// end keeperhub code //
```

---

## Phase 6: Anonymous User Handling

### Trial Mode Banner

**`keeperhub/components/trial-banner.tsx`**

```tsx
"use client";

import { useSession } from "@/lib/auth-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function TrialBanner() {
  const { data: session } = useSession();
  const [dismissed, setDismissed] = useState(false);
  const router = useRouter();

  // Only show for anonymous users
  if (!session?.user || session.user.email || dismissed) {
    return null;
  }

  return (
    <Alert className="rounded-none border-x-0 border-t-0">
      <AlertDescription className="flex items-center justify-between">
        <span>
          You're in trial mode. Sign up to save your work and collaborate with your team.
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => router.push("/sign-up")}>
            Create Account
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDismissed(true)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
```

Add to layout:

```tsx
// app/layout.tsx
// start custom keeperhub code //
import { TrialBanner } from "@/keeperhub/components/trial-banner";
// end keeperhub code //

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {/* start custom keeperhub code // */}
        <TrialBanner />
        {/* end keeperhub code // */}
        {children}
      </body>
    </html>
  );
}
```

---

## Phase 7: Email Integration (SendGrid)

### Update Invitation Email Handler

**`lib/auth.ts`** (Update the sendInvitationEmail function)

```typescript
// start custom keeperhub code //
import { sendEmail } from "@/keeperhub/lib/email"; // Assuming SendGrid helper exists

organization({
  // ... other config
  async sendInvitationEmail(data) {
    const inviteLink = `${process.env.NEXT_PUBLIC_APP_URL}/accept-invite/${data.id}`;

    await sendEmail({
      to: data.email,
      subject: `Join ${data.organization.name} on Workflow Builder`,
      template: "organization-invitation",
      data: {
        inviterName: data.inviter.user.name || "A team member",
        organizationName: data.organization.name,
        role: data.role,
        inviteLink,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString(),
      },
    });
  },
});
// end keeperhub code //
```

---

## Phase 8: Data Migration

### Migration Script

**`scripts/migrate-to-organizations.ts`**

```typescript
import { db } from "../lib/db";
import { users, workflows, integrations, organization, member } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

async function migrateToOrganizations() {
  console.log("Starting organization migration...");

  // Get all users
  const allUsers = await db.select().from(users);

  for (const user of allUsers) {
    console.log(`Processing user: ${user.email}`);

    // Create a "Personal" organization for each user
    const orgId = nanoid();
    const orgSlug = `${user.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${orgId.slice(0, 6)}`;

    await db.insert(organization).values({
      id: orgId,
      name: `${user.name}'s Organization`,
      slug: orgSlug,
      createdAt: new Date(),
    });

    // Add user as owner
    await db.insert(member).values({
      id: nanoid(),
      userId: user.id,
      organizationId: orgId,
      role: "owner",
      createdAt: new Date(),
    });

    // Migrate workflows
    await db
      .update(workflows)
      .set({ organizationId: orgId })
      .where(eq(workflows.userId, user.id));

    // Migrate credentials
    await db
      .update(integrations)
      .set({ organizationId: orgId })
      .where(eq(integrations.userId, user.id));

    console.log(`✓ Migrated user ${user.email} to organization ${orgSlug}`);
  }

  console.log("Migration complete!");
}

migrateToOrganizations().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
```

Run migration:

```bash
tsx scripts/migrate-to-organizations.ts
```

---

## Phase 9: Testing

### Unit Tests

**`keeperhub/lib/hooks/__tests__/use-organization.test.ts`**

```typescript
import { renderHook } from "@testing-library/react";
import { useOrganization } from "../use-organization";
import { authClient } from "@/lib/auth-client";

jest.mock("@/lib/auth-client");

describe("useOrganization", () => {
  it("returns current organization", async () => {
    const mockOrg = { id: "org-1", name: "Test Org", slug: "test-org" };
    (authClient.useActiveOrganization as jest.Mock).mockReturnValue({
      data: mockOrg,
      isPending: false,
    });

    const { result } = renderHook(() => useOrganization());

    expect(result.current.organization).toEqual(mockOrg);
  });

  it("handles loading state", () => {
    (authClient.useActiveOrganization as jest.Mock).mockReturnValue({
      data: null,
      isPending: true,
    });

    const { result } = renderHook(() => useOrganization());

    expect(result.current.isLoading).toBe(true);
  });
});
```

### Integration Tests

**`tests/integration/organization-flow.test.ts`**

```typescript
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organization, member } from "@/lib/db/schema";

describe("Organization Flow", () => {
  it("creates organization and assigns owner role", async () => {
    // Create test user
    const user = await createTestUser();

    // Create organization
    const orgData = await auth.api.createOrganization({
      body: { name: "Test Org", slug: "test-org" },
      headers: await getAuthHeaders(user),
    });

    expect(orgData.organization.name).toBe("Test Org");

    // Check membership
    const membership = await db.query.member.findFirst({
      where: (m, { and, eq }) =>
        and(
          eq(m.userId, user.id),
          eq(m.organizationId, orgData.organization.id)
        ),
    });

    expect(membership?.role).toBe("owner");
  });

  it("sends invitation and allows acceptance", async () => {
    // Setup: Create org with owner
    const owner = await createTestUser();
    const org = await createTestOrganization(owner);

    // Owner sends invite
    const invite = await auth.api.inviteMember({
      body: {
        email: "newmember@test.com",
        role: "member",
        organizationId: org.id,
      },
      headers: await getAuthHeaders(owner),
    });

    expect(invite.email).toBe("newmember@test.com");

    // New user accepts invite
    const newUser = await createTestUser("newmember@test.com");
    await auth.api.acceptInvitation({
      body: { invitationId: invite.id },
      headers: await getAuthHeaders(newUser),
    });

    // Check membership created
    const membership = await db.query.member.findFirst({
      where: (m, { and, eq }) =>
        and(eq(m.userId, newUser.id), eq(m.organizationId, org.id)),
    });

    expect(membership?.role).toBe("member");
  });
});
```

### E2E Tests

**`tests/e2e/organization.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";

test("complete organization flow", async ({ page, context }) => {
  // User 1: Sign up and create org
  await page.goto("/sign-up");
  await page.fill('input[name="email"]', "owner@test.com");
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL("/onboarding/organization");

  await page.click('text="Create Organization"');
  await page.fill('input[name="name"]', "Test Corp");
  await page.fill('input[name="slug"]', "test-corp");
  await page.click('button:has-text("Create")');

  await expect(page).toHaveURL("/dashboard");
  await expect(page.locator("text=Test Corp")).toBeVisible();

  // Navigate to invite member
  await page.goto("/settings/members");
  await page.click('button:has-text("Invite Member")');
  await page.fill('input[name="email"]', "member@test.com");
  await page.selectOption('select[name="role"]', "admin");
  await page.click('button:has-text("Send Invitation")');

  // Copy invite code
  const inviteCode = await page
    .locator('[data-testid="invite-code"]')
    .textContent();

  // User 2: Sign up and join via invite
  const page2 = await context.newPage();
  await page2.goto("/sign-up");
  await page2.fill('input[name="email"]', "member@test.com");
  await page2.fill('input[name="password"]', "password123");
  await page2.click('button[type="submit"]');

  await page2.click('text="Join Organization"');
  await page2.fill('input[name="code"]', inviteCode!);
  await page2.click('button:has-text("Join")');

  await expect(page2).toHaveURL("/dashboard");
  await expect(page2.locator("text=Test Corp")).toBeVisible();
});
```

---

## Phase 10: Deployment

### Pre-Deployment Checklist

- [ ] Run all tests (`pnpm test && pnpm test:e2e`)
- [ ] Test migration script on staging database
- [ ] Verify environment variables in production:
  - `NEXT_PUBLIC_APP_URL`
  - `BETTER_AUTH_URL`
- [ ] Review better-auth logs for any configuration issues
- [ ] Test invite email delivery (SendGrid)

### Deployment Steps

1. **Deploy schema changes:**
   ```bash
   npx @better-auth/cli generate
   pnpm db:push
   ```

2. **Run migration script:**
   ```bash
   tsx scripts/migrate-to-organizations.ts
   ```

3. **Deploy application:**
   ```bash
   pnpm build
   # Deploy to your platform
   ```

4. **Post-deployment validation:**
   - Test user registration → org creation
   - Test invite flow
   - Test org switching
   - Test Wallet access control
   - Test workflow scoping

---

## Implementation Checklist

### Database & Auth
- [ ] Enable organization plugin in auth config
- [ ] Define custom access control (workflow, credential, wallet)
- [ ] Run better-auth migrations
- [ ] Add organizationId to workflows table
- [ ] Add organizationId to integrations table
- [ ] Write migration script
- [ ] Test migration on dev data

### Middleware & Context
- [ ] Create org-context middleware
- [ ] Create requireOrganization wrapper
- [ ] Create permission helpers
- [ ] Add org context to API routes

### React Hooks
- [ ] useOrganization hook
- [ ] useOrganizations hook
- [ ] useActiveMember hook
- [ ] usePermissions hook
- [ ] useRequireOrganization guard hook

### UI Components
- [ ] Organization setup flow
- [ ] Organization switcher
- [ ] Members list
- [ ] Invite modal
- [ ] Trial banner
- [ ] Organization settings page

### Core Integration
- [ ] Scope workflows by organization
- [ ] Scope credentials by organization
- [ ] Update Wallet credential form (admin-only)
- [ ] Apply org guards to protected pages
- [ ] Update anonymous account linking (delete trial data)

### Email Integration
- [ ] Implement sendInvitationEmail with SendGrid
- [ ] Create email template
- [ ] Test email delivery

### Testing
- [ ] Unit tests for hooks
- [ ] Integration tests for org lifecycle
- [ ] E2E tests for complete flow
- [ ] Manual QA checklist

### Deployment
- [ ] Deploy to staging
- [ ] Run migration on staging DB
- [ ] Smoke test all features
- [ ] Deploy to production
- [ ] Monitor logs and metrics

---

## Development Timeline (No time estimates per guidelines)

### Sprint 1: Foundation
- Enable organization plugin
- Database schema + migrations
- Middleware & context

### Sprint 2: Core Features
- React hooks
- API integration
- Workflow/credential scoping

### Sprint 3: UI
- Organization setup flow
- Switcher & member management
- Settings page

### Sprint 4: Integration
- Wallet integration
- Anonymous user handling
- Trial banner

### Sprint 5: Polish
- Email integration
- Testing suite
- Bug fixes

### Sprint 6: Deploy
- Migration testing
- Production deployment
- Monitoring

---

## Risk Mitigation

**Data Loss Prevention:**
- Idempotent migration script
- Test on staging first
- Database backup before migration
- Rollback plan: restore from backup

**Performance:**
- Index on organizationId columns
- Cache active org in session (better-auth handles this)
- Monitor query performance

**Security:**
- Better-auth handles permission checking
- Always validate org membership
- Rate limit invitations
- Expire invites after 7 days

**UX:**
- Clear error messages
- Loading states everywhere
- Smooth org switching
- Preserve context during switch

---

## Success Metrics

- [ ] Zero data loss during migration
- [ ] <100ms overhead for org context checks
- [ ] 100% test coverage for permission logic
- [ ] Successful multi-org workflows in production
- [ ] No auth/permission bugs in first week

---

## Resources

**Better-Auth Documentation:**
- [Organization Plugin](https://www.better-auth.com/docs/plugins/organization)
- [Access Control](https://www.better-auth.com/docs/plugins/organization#custom-access-control)
- [Dynamic Roles](https://www.better-auth.com/docs/plugins/organization#dynamic-access-control)

**Related Articles:**
- [Building Multi-Tenant Apps with Better-Auth](https://zenstack.dev/blog/better-auth)
- [Multi-Tenant SaaS with Better-Auth in Fastify](https://peerlist.io/shrey_/articles/building-better-auth-in-fastify-multitenant-saas-and-secure-api-authentication)

---

**Last Updated:** 2026-01-07
