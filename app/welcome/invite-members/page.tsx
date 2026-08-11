import { InviteMembersStep } from "@/components/welcome/steps/invite-members-step";
import { requireOnboardingSession } from "@/lib/onboarding-session";

export default async function InviteMembersPage(): Promise<React.ReactElement> {
  await requireOnboardingSession();
  return <InviteMembersStep />;
}
