import { redirect } from "next/navigation";

/**
 * Settings has no landing page of its own: the rail is the index, and its
 * search finds an individual setting. Land on the first section instead.
 */
export default function SettingsIndex(): never {
  redirect("/settings/account");
}
