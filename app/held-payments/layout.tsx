import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Held Payments",
  description:
    "Tempo payments signed and held, ready to broadcast now or on schedule.",
};

export default function HeldPaymentsLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return <>{children}</>;
}
