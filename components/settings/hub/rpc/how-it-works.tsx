import { ArrowDownUp, Lock, Network } from "lucide-react";
import { YOUR_ENDPOINTS_ONLY } from "./model";

const STEPS = [
  {
    icon: Network,
    title: "Your endpoints come first",
    text: "Steps and triggers on a chain use that chain's default endpoint, unless a step picks another one.",
  },
  {
    icon: ArrowDownUp,
    title: "KeeperHub is the backup",
    text: "A config without a fallback of its own falls back to KeeperHub's endpoint, and calls it cannot serve, such as a trigger that needs WSS, use KeeperHub's endpoints.",
  },
  {
    icon: Lock,
    title: YOUR_ENDPOINTS_ONLY,
    text: "Turn it on for a chain to never use KeeperHub's endpoints there. If your endpoints fail, the step fails.",
  },
] as const;

/** How the organization's endpoints and KeeperHub's share the traffic. */
export function RpcHowItWorks(): React.ReactElement {
  return (
    <ol
      aria-label="How RPC endpoints work"
      className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3"
    >
      {STEPS.map((step) => (
        <li className="flex gap-2.5" key={step.title}>
          <step.icon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-sm">{step.title}</span>
            <span className="text-muted-foreground text-xs">{step.text}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
