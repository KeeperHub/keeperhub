import { ConnectAgentStep } from "@/components/welcome/steps/connect-agent-step";
import { requireOnboardingSession } from "@/lib/onboarding-session";

export default async function ConnectAgentPage(): Promise<React.ReactElement> {
  await requireOnboardingSession();
  return <ConnectAgentStep />;
}
