"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ProtocolDefinition } from "@/lib/protocol-registry";
import { ProtocolDetail } from "./protocol-detail";

export function ProtocolDetailPage({
  protocol,
}: {
  protocol: ProtocolDefinition;
}): React.ReactElement {
  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="mx-auto w-full max-w-5xl px-4 py-8">
          <Link
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            href="/hub"
          >
            <ArrowLeft className="size-4" />
            Back to Hub
          </Link>
          <ProtocolDetail
            hideBackButton
            modalUrl={`/hub?protocol=${protocol.slug}`}
            protocol={protocol}
          />
        </div>
      </div>
    </div>
  );
}
