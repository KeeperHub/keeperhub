"use client";

import { Suspense } from "react";
import { ScanLanding } from "@/components/scan/scan-landing";

export default function ScanPage(): React.ReactElement {
  // useSearchParams in ScanLanding requires a Suspense boundary so the
  // static prerender of this route can bail out to client rendering.
  return (
    <Suspense fallback={null}>
      <ScanLanding />
    </Suspense>
  );
}
