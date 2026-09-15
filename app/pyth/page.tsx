import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { PythShowcase } from "@/components/pyth/pyth-showcase";
import { isPythPriceTriggerEnabled } from "@/lib/pyth/feature-flag";

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

export const dynamic = "force-dynamic";

export default function PythPage() {
  if (!isPythPriceTriggerEnabled()) {
    notFound();
  }
  return <PythShowcase />;
}
