"use client";

import { Badge } from "@/components/ui/badge";
import { PolicyRiskClass, RISK_CLASS_LABEL } from "@/lib/policy/catalog";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/**
 * Risk class drives the badge weight, so scanning a long function list surfaces
 * what is dangerous without reading any signature.
 */
const RISK_VARIANT: Record<string, BadgeVariant> = {
  [PolicyRiskClass.ACCESS_CONTROL]: "destructive",
  [PolicyRiskClass.EMERGENCY]: "destructive",
  [PolicyRiskClass.APPROVAL]: "default",
  [PolicyRiskClass.VALUE_TRANSFER]: "default",
  [PolicyRiskClass.POSITION_MANAGEMENT]: "secondary",
  [PolicyRiskClass.UNKNOWN]: "outline",
  [PolicyRiskClass.READ]: "outline",
};

export function RiskBadge({
  riskClass,
}: {
  riskClass: string;
}): React.ReactElement {
  return (
    <Badge variant={RISK_VARIANT[riskClass] ?? "outline"}>
      {RISK_CLASS_LABEL[riskClass as PolicyRiskClass] ?? riskClass}
    </Badge>
  );
}
