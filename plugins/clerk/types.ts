import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
export type ClerkApiUser = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email_addresses: Array<{
    id: string;
    email_address: string;
  }>;
  primary_email_address_id: string | null;
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

/**
 * Flat user data for workflow steps
 */
export type ClerkUserData = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * Standard step output format
 */
export type ClerkUserResult =
  | { success: true; data: ClerkUserData }
  | {
      success: false;
      error: { message: string };
      errorClass?: ExecutionErrorType;
    };

export function toClerkUserData(apiUser: ClerkApiUser): ClerkUserData {
  const primaryEmail = apiUser.email_addresses.find(
    (e) => e.id === apiUser.primary_email_address_id
  );
  return {
    id: apiUser.id,
    firstName: apiUser.first_name,
    lastName: apiUser.last_name,
    primaryEmailAddress: primaryEmail?.email_address ?? null,
    createdAt: apiUser.created_at,
    updatedAt: apiUser.updated_at,
  };
}
