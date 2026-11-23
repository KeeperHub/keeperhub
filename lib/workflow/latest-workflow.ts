import { filterPickerVisible } from "@/lib/workflow/soft-delete";

/**
 * The workflow last updated, among those the workflow lists show (not the
 * internal "__current__" scratch workflow, nor a deleted one).
 */
export function latestVisibleWorkflow<
  T extends {
    name: string;
    updatedAt: string;
    deletedAt?: Date | string | null;
  },
>(workflows: T[]): T | undefined {
  return filterPickerVisible(workflows).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )[0];
}

/**
 * The workflow created last, of any (the /workflows index's default, kept as
 * it was).
 */
export function newestWorkflow<T extends { createdAt: string }>(
  workflows: T[]
): T | undefined {
  return [...workflows].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];
}
