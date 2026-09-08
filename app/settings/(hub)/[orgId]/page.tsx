import { redirect } from "next/navigation";

/** An organization on its own has no page; land on its members. */
export default async function OrgSettingsIndex({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/settings/${orgId}/organization`);
}
