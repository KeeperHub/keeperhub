"use client";

import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import {
  ConfigureConnectionForm,
  ConnectionTypePicker,
} from "@/components/overlays/add-connection-overlay";
import { Button } from "@/components/ui/button";
import type { IntegrationType } from "@/lib/types/integration";
import { SettingsCard } from "./section";

/**
 * Pick a service, then enter its credentials -- both steps on the page. This
 * replaces the stacked Add Connection / Configure Connection modals.
 */
export function AddConnectionPanel({
  onDone,
}: {
  onDone: () => void;
}): React.ReactElement {
  const [type, setType] = useState<IntegrationType | null>(null);

  if (!type) {
    return (
      <SettingsCard
        action={
          <Button onClick={onDone} size="sm" variant="ghost">
            Cancel
          </Button>
        }
        description="Select the service you want to connect."
        title="Add a connection"
      >
        <ConnectionTypePicker onSelect={setType} />
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      action={
        <Button onClick={() => setType(null)} size="sm" variant="ghost">
          <ArrowLeft className="size-3.5" />
          Change service
        </Button>
      }
      description="Enter the credentials KeeperHub should use for this service."
      title="Configure connection"
    >
      <ConfigureConnectionForm
        inline
        onCancel={onDone}
        onSuccess={onDone}
        type={type}
      />
    </SettingsCard>
  );
}
