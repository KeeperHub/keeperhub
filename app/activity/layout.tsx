import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Activity | KeeperHub",
  description: "Recent security-sensitive actions across your organization",
};

export default function ActivityLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <>{children}</>;
}
