import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Earnings | KeeperHub",
  description: "Revenue and invocation analytics for your listed workflows",
};

export default function EarningsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <>{children}</>;
}
