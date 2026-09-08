import { PayPerExecutionStep } from "@/components/welcome/steps/pay-per-execution-step";
import { requireOnboardingSession } from "@/lib/onboarding-session";

export default async function PayPerExecutionPage(): Promise<React.ReactElement> {
  await requireOnboardingSession();
  return <PayPerExecutionStep />;
}
