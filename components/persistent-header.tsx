"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkflowIcon } from "@/components/ui/workflow-icon";
import { UserMenu } from "@/components/workflows/user-menu";
import { getCustomLogo } from "@/lib/workflow/editor/extension-registry";

export function PersistentHeader() {
  const pathname = usePathname();

  // Only show on non-workflow pages (workflow pages have their own toolbar)
  const isWorkflowPage = pathname === "/" || pathname.startsWith("/workflows/");

  if (isWorkflowPage) {
    return null;
  }

  const CustomLogo = getCustomLogo();

  return (
    <div className="pointer-events-auto fixed top-0 right-0 left-0 z-50 flex items-center justify-between border-b bg-background px-4 py-3">
      {/* Left side: Logo + Menu */}
      <div className="flex items-center gap-2">
        {CustomLogo && <CustomLogo className="size-7 shrink-0" />}
        <div className="flex h-9 max-w-[160px] items-center overflow-hidden rounded-md border bg-secondary text-secondary-foreground sm:max-w-none">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-full cursor-pointer items-center gap-2 px-3 font-medium text-sm transition-all hover:bg-black/5 dark:hover:bg-white/5">
              <WorkflowIcon className="size-4 shrink-0" />
              <p className="truncate font-medium text-sm">
                <span className="sm:hidden">Menu</span>
                <span className="hidden sm:inline">Menu</span>
              </p>
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuItem
                asChild
                className="flex items-center justify-between"
              >
                <Link href="/">New Workflow</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Right side: User Menu */}
      <div className="flex items-center gap-2">
        <UserMenu />
      </div>
    </div>
  );
}
