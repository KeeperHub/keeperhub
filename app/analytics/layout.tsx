import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Analytics | KeeperHub",
  description: "Execution analytics and gas tracking for your organization",
};

export default function AnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <>{children}</>;
}
