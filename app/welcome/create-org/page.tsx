import { CreateOrgStep } from "@/components/welcome/steps/create-org-step";
import { requireOnboardingSession } from "@/lib/onboarding-session";

export default async function CreateOrgPage(): Promise<React.ReactElement> {
  await requireOnboardingSession();
  return <CreateOrgStep />;
}
