"use client";

import { useSpendCaps } from "./hooks/use-spend-caps";
import { CapRow } from "./limits/cap-row";
import { SectionHeader, SettingsCard } from "./section";
import { FormSkeleton } from "./skeletons";

export function LimitsSection(): React.ReactElement {
  const { caps, loading, saving, save } = useSpendCaps();

  return (
    <>
      <SectionHeader
        description="The most native value workflow runs and direct execution calls can move per day. A run that would cross the cap stops instead of signing."
        title="Spending limits"
      />

      <SettingsCard
        description="EVM and Solana are capped separately, each in its own currency. Leave a field empty to fall back to the platform default; there is no uncapped setting."
        title="Daily value caps"
      >
        {loading ? (
          <FormSkeleton rows={3} />
        ) : (
          <div className="flex flex-col gap-3">
            {caps.map((cap) => (
              <CapRow
                cap={cap}
                disabled={saving}
                key={cap.id}
                onSave={(base) => save(cap.id, base)}
              />
            ))}
          </div>
        )}
      </SettingsCard>
    </>
  );
}
