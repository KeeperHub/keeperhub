import type { Metadata, Viewport } from "next";
import { PythShowcase } from "@/components/pyth/pyth-showcase";

export const metadata: Metadata = {
  title: "Pyth Price Triggers | KeeperHub",
  description:
    "Turn Pyth price signals into KeeperHub workflows. Explore a verified execution and configure your native price trigger.",
  alternates: { canonical: "/pyth" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default function PythPage() {
  return <PythShowcase />;
}
