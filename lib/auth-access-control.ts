import { createAccessControl } from "better-auth/plugins/access";

// Shared by the server (lib/auth.ts) and the client (lib/auth-client.ts) so
// both sides evaluate the same role permissions.
const statement = {
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["read", "update", "delete"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "cancel"],
} as const;

export const ac = createAccessControl(statement);

// Read-only: sees everything in the org, changes nothing.
const viewerRole = ac.newRole({
  workflow: ["read"],
  credential: ["read"],
  wallet: ["read"],
  organization: ["read"],
  member: ["read"],
});

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

export const orgRoles = {
  owner: ownerRole,
  admin: adminRole,
  member: memberRole,
  viewer: viewerRole,
};
