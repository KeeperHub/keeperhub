"use client";

import dynamic from "next/dynamic";
import { Spinner } from "@/components/ui/spinner";

function LoadingButton(): React.ReactElement {
  return (
    <div className="flex h-8 w-full items-center justify-center">
      <Spinner className="h-4 w-4" />
    </div>
  );
}

export const ParaExportKeyButton = dynamic(
  () => import("./para-export-key-button").then((m) => m.ParaExportKeyButton),
  { ssr: false, loading: LoadingButton }
);
